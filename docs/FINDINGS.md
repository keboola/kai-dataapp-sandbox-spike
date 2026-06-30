# AI-3434 Findings — Keboola Data App as a Kai sandbox

**Date:** 2026-06-30 · **Spike repo:** `kai-dataapp-sandbox` · **Target:** canary-orion, project 198 (app 374693)

## TL;DR

**Viable.** A Keboola python-js Data App can host the unmodified Kai Claude-Agent-SDK runtime and be driven over HTTP the way kai-agent drives an E2B microVM today. Proven end-to-end **locally** (Docker) and on a **real data app on canary**: real Kai turns streamed assistant output and executed Keboola MCP tools, with LLM + MCP flowing through kai-agent's existing credential proxy. One hard blocker (R8, non-root writable dirs) has a trivial fix; one genuine semantic gap vs E2B (lifecycle is cold-restart, not stateful pause).

## What was built (no changes to kai-agent / kai-agent-sandbox source)

- An HTTP **sandbox host** (Express) mirroring E2B's drive surface: `POST /files/*`, `POST /commands` (spawn + **SSE** stdout/stderr), `POST /commands/:pid/stdin`, `DELETE /commands/:pid`, health. It runs the unmodified `@keboola/kai-agent-sandbox` `entrypoint.js` as a child.
- A **driver** standing in for kai-agent: uploads the runtime (mirrors `readSandboxFiles()`), discovers the container IP, mints a proxy session, streams a turn, auto-approves tools.
- Deployed two ways: M1 local Docker; M2 a **managed-git python-js data app** on canary via the Sandbox Service API (`POST /apps` `useManagedGitRepo:true` → git creds → push → `PATCH desiredState:running`).
- Two pieces of scaffolding: a dev-only `POST /proxy/_dev/mint-session` on kai-agent (dev-gated, fails closed in prod), and the driver's apps-proxy cookie-login.

## 1. Architectural fit

Strong. kai-agent's E2B dependency is a small, well-shaped surface (files write/read/list/remove; background process with streamed stdout/stderr + stdin; kill; lifecycle). It maps almost 1:1 onto an HTTP host, so a future `Sandbox` interface can abstract "E2B gRPC" vs "data-app HTTP" cleanly. Two facts made this easy:

- kai-agent already ships the SDK runtime **over the wire** each turn (`readSandboxFiles()` → `files.write` → `commands.run("node entrypoint.js")`), so the HTTP host only had to be a generic Node sandbox host — the runtime files transferred unchanged.
- The sandbox's stdin prompt protocol and JSON-per-line `SandboxStdoutMessage` stdout protocol are transport-agnostic; SSE carried them verbatim.

The one structural mismatch is lifecycle (see §3 / R7): E2B `pause` preserves FS + memory; a data app suspend is a cold restart.

## 2. Single-tenant fit and gaps

The strategic win: a data app runs **inside the customer's Keboola stack** — the same trust boundary as their data — whereas E2B is a third-party multi-tenant microVM cloud. For single-tenant / data-residency-constrained customers who can't ship turn data to E2B, this is the motivating reason and it holds up.

Gaps specific to single-tenant:

- **Non-root container (R8):** the python-js base image runs as `app` (uid 1000); `/opt` and `/home/user` are unwritable. The Kai entrypoint hardcodes `/opt/kai-agent` + `/home/user/workspace`, so a stock data app can't use them as-is. (Fix below.)
- **In-stack proxy:** the sandbox reaches LLM/MCP through kai-agent's proxy. In a single-tenant deploy that proxy is co-located in-stack (or, since the stack is the trust boundary, the credential-isolation indirection could be simplified). Egress to the proxy worked from the canary container.

## 3. Security / isolation / networking / lifecycle

- **Isolation:** k8s-pod container, non-root uid 1000 (vs E2B microVM). Weaker hardware isolation than a microVM, but in-stack and same-tenant.
- **Auth:** apps-proxy fronts the app with a **form-login → session cookie** (not HTTP Basic; OIDC and none are also options). A real kai-agent→data-app integration must perform this handshake — the spike's driver does (GET `_csrf` + cookie → POST password → cookie on all calls). The in-app bearer is a second, optional layer.
- **Networking:** container has outbound egress (reached the proxy via ngrok); **SSE streaming survives apps-proxy** (assistant tokens streamed through it). In-container nginx needs `proxy_buffering off` (set in `keboola-config/nginx`).
- **Credential isolation preserved:** the container held only an opaque, IP-bound proxy session token; the proxy swapped in real Vertex creds (LLM) and the canary storage token (MCP). Verified: `mcp__keboola__get_buckets` ran through the proxy against project 198.
- **Lifecycle (R7) — the key gap:** a manual suspend→resume took ~32s and was a **cold restart** — `setup.sh` re-ran (node_modules reinstalled from cache) and the driver-uploaded runtime in `/tmp` (entrypoint.js, dist, config, skills) was **wiped**. This differs fundamentally from E2B's state-preserving `pause`. Implications: the host must **re-upload the runtime after every resume**, and SDK **session continuity** (the SDK's session transcript files) will not survive a cold restart on ephemeral `/tmp` — it needs either per-sandbox **persistent storage** (the Sandbox API exposes `k8sStorageClassName`) or host-driven re-upload + `SDK_SESSION_ID` resume from durable storage.

## 4. Reuse of existing work

- **kai-agent proxy** (`src/proxy/`) — reused unchanged for LLM + MCP credential injection and IP-bound session tokens.
- **`@keboola/kai-agent-sandbox`** runtime — reused **unchanged**, uploaded over the wire (incl. the full Agent SDK + OTel + langsmith dep graph, which installs and runs cleanly under plain `npm` — the yarn `langsmith` patch was not needed with tracing off).
- **Sandbox Service / data-science API** — managed-git provisioning (`useManagedGitRepo`), git http-token creds, deploy, logs, lifecycle.
- **apps-proxy** — ingress, auth, and (validated) SSE pass-through.

## 5. Recommendation & next steps

**Recommendation: viable; pursue as the single-tenant (and E2B-alternative) sandbox.** The spike retired every feasibility risk (R1–R8). Productionization work, roughly in order:

1. **`config.ts`: make `SANDBOX_RUNTIME_DIR` + `WORKSPACE_DIR` env-configurable** (the only hard blocker, R8). Trivial change; lets a non-root data app use writable paths. The spike proved this works by patching the uploaded `config.js` to `/tmp/*`.
2. **Extract a `Sandbox` interface in kai-agent** (create/connect/pause/kill, `files.*`, `commands.*` with streamed stdout + stdin) with the E2B impl as one conformer and a `DataAppSandbox` impl behind a feature flag — the AI-3434/AI-3454-style goal. The HTTP surface here is the contract.
3. **Productionize the sandbox host** — ship `server.mjs` + `keboola-config/` as the data-app repo/image (stock python-js base + `setup.sh`, no custom registry needed).
4. **Lifecycle handling** — re-upload runtime on resume; for session continuity use per-sandbox persistent storage for the SDK session dir, or persist `sdk_session_id` (kai-agent already does) + re-upload + resume.
5. **apps-proxy auth** — implement the cookie (or OIDC) handshake in the real driver; decide the auth mode for sandbox apps.
6. **Watch `setup.sh` install time vs the startup-probe window** (fit comfortably on canary, but the SDK dep set is heavy).

### Operational notes (observed, not feasibility blockers)

- kai-agent's **dev** proxy intermittently threw undici `fetch failed: expected non-null body source` on LLM forwarding after long uptime (MCP forwarding unaffected); a process restart cleared it — looks like a stale-state/undici edge in the long-running dev proxy, orthogonal to the sandbox.
- apps-proxy returned occasional 502s on a heavily stop/started throwaway app.
- Git-commit-locking: a data app re-checks out the first-deploy SHA on redeploy; to ship new code, recreate the app or bump the config version.
- In dev via ngrok, the container's outbound IP appears as `::1`, so session IP-binding lines up automatically.
