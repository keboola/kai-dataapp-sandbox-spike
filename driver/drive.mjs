import fs from 'node:fs';
import path from 'node:path';

// R8: on a non-root data app the entrypoint's default dirs (/opt/kai-agent, /home/user/workspace)
// aren't writable, so these are overridable. Defaults keep M1 (local Docker, root) unchanged.
const RUNTIME_DIR = process.env.KAI_RUNTIME_DIR ?? '/opt/kai-agent';
const WORKSPACE_DIR = process.env.KAI_WORKSPACE_DIR ?? '/home/user/workspace';

// M2: when driving a deployed data app, requests go through apps-proxy, which gates with a
// form-login that sets a session cookie (NOT HTTP Basic). Set APP_PASSWORD to enable. The same
// handshake a real kai-agent->data-app integration would perform.
let appCookie = '';

function appHeaders(bearer, json = true) {
  const h = {};
  if (json) h['content-type'] = 'application/json';
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (appCookie) h.cookie = appCookie;
  return h;
}

async function loginAppsProxy(baseUrl, password) {
  const jar = new Map();
  const merge = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  };
  const cookieStr = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const g = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  merge(g);
  const m = (await g.text()).match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('apps-proxy login: no _csrf on login page');
  const body = new URLSearchParams({ password, _csrf: m[1], submit: '' }).toString();
  const p = await fetch(`${baseUrl}/`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieStr() },
    body,
  });
  merge(p);
  appCookie = cookieStr();
  if (!appCookie) throw new Error('apps-proxy login: no session cookie after POST');
  console.log('apps-proxy login ok');
}

function cfg() {
  const baseUrl = process.env.SANDBOX_URL ?? 'http://localhost:3000';
  const bearer = process.env.SANDBOX_BEARER ?? 'devsecret';
  const distDir =
    process.env.KAI_SANDBOX_DIST ?? '/Users/adamvyborny/Code/ui/packages/kai-agent-sandbox/dist';
  return { baseUrl, bearer, distDir };
}

async function writeFile(baseUrl, bearer, p, data) {
  const res = await fetch(`${baseUrl}/files/write`, {
    method: 'POST',
    headers: appHeaders(bearer),
    body: JSON.stringify({ path: p, data }),
  });
  if (!res.ok) throw new Error(`write ${p} failed: ${res.status} ${await res.text()}`);
}

function collectRuntimeFiles(distDir) {
  const files = [{ name: 'package.json', content: '{"type":"module"}\n' }];
  for (const name of fs.readdirSync(distDir).sort()) {
    if (name.endsWith('.js') && name !== 'index.js') {
      let content = fs.readFileSync(path.join(distDir, name), 'utf8');
      if (name === 'config.js') {
        // R8 relocation: repoint the entrypoint's hardcoded runtime/workspace dirs (the only
        // place they're literal-encoded; TOOL_RESULTS_DIR derives from WORKSPACE_DIR). No-op
        // when RUNTIME_DIR/WORKSPACE_DIR equal the originals (M1).
        content = content
          .replaceAll("'/home/user/workspace'", `'${WORKSPACE_DIR}'`)
          .replaceAll("'/opt/kai-agent'", `'${RUNTIME_DIR}'`);
      }
      files.push({ name, content });
    }
  }
  // Skills: siblings of dist/ → skills/ and vendored-skills/. Spike simplification:
  // we walk first-party skills/ in full, whereas kai-agent's readSandboxFiles() emits only
  // first-party SKILL.md + scaffold/. Output is identical for today's tree (first-party
  // skills carry only SKILL.md + scaffold/); revisit if a first-party skill adds other files.
  const pkgRoot = path.dirname(distDir);
  for (const dirName of ['skills', 'vendored-skills']) {
    const root = path.join(pkgRoot, dirName);
    if (!fs.existsSync(root)) continue;
    for (const rel of walk(root)) {
      files.push({
        name: `.claude/skills/${rel}`,
        content: fs.readFileSync(path.join(root, rel), 'utf8'),
      });
    }
  }
  return files;
}

function walk(root, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(path.join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

export async function uploadRuntime({ baseUrl, bearer, distDir }) {
  for (const f of collectRuntimeFiles(distDir)) {
    await writeFile(baseUrl, bearer, `${RUNTIME_DIR}/${f.name}`, f.content);
  }
  console.log('runtime uploaded');
}

// Consume the /commands SSE stream, calling onEvent(evt) per event. onEvent may be async and
// returns true to stop early (we cancel the reader). Resolves when the stream ends.
async function streamCommand(baseUrl, bearer, spec, onEvent) {
  const res = await fetch(`${baseUrl}/commands`, {
    method: 'POST',
    headers: appHeaders(bearer),
    body: JSON.stringify(spec),
  });
  if (!res.ok) throw new Error(`/commands failed: ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const evt = JSON.parse(line.slice(6));
      if (await onEvent(evt)) {
        await reader.cancel();
        return;
      }
    }
  }
}

// Mirrors kai-agent's discoverSandboxIp: have the sandbox curl the proxy's /client-ip so we
// learn the outbound IP it appears from, to bind the session token to it.
async function discoverContainerIp({ baseUrl, bearer }) {
  const PROXY = process.env.PROXY_BASE_HOST;
  if (!PROXY) throw new Error('PROXY_BASE_HOST required (ngrok URL of local kai-agent)');
  // The slim base image has no curl, so use node's global fetch (the same transport the SDK
  // uses) to hit the proxy's /client-ip and learn the outbound IP for session binding.
  const code = `fetch(${JSON.stringify(`${PROXY}/proxy/client-ip`)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{process.stderr.write('FETCH_ERR '+String(e));process.exit(3)})`;
  let out = '';
  let spawnError = null;
  await streamCommand(baseUrl, bearer, { cmd: 'node', args: ['-e', code] }, (evt) => {
    if (evt.type === 'stdout') out += evt.chunk;
    if (evt.type === 'stderr') process.stderr.write(`[ip stderr] ${evt.chunk}`);
    if (evt.type === 'error') spawnError = evt.error;
    return evt.type === 'exit' || evt.type === 'error';
  });
  if (spawnError) throw new Error(`ip discovery spawn error: ${spawnError}`);
  const trimmed = out.trim();
  if (!trimmed) throw new Error('ip discovery returned empty output');
  const ip = JSON.parse(trimmed).ip;
  console.log('container outbound IP (as seen by proxy):', ip);
  return ip;
}

// Calls the DEV-ONLY /proxy/_dev/mint-session endpoint to register a proxy session token bound
// to the container's IP, with the canary storage token behind it (the proxy swaps it in).
async function mintSession(allowedIp) {
  const PROXY = process.env.PROXY_BASE_HOST;
  const token = process.env.KBC_CANARY_TOKEN;
  if (!token) throw new Error('KBC_CANARY_TOKEN required (source canary.env)');
  const res = await fetch(`${PROXY}/proxy/_dev/mint-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ storageApiToken: token, chatId: 'spike-chat', allowedIp }),
  });
  if (!res.ok) throw new Error(`mint-session failed: ${res.status} ${await res.text()}`);
  const { sessionToken } = await res.json();
  return sessionToken;
}

// Mirrors entrypoint-builder.ts (Vertex path). Container holds only the opaque session token;
// the proxy injects real Vertex creds + the canary storage token upstream.
function buildEnv(sessionToken) {
  const PROXY = process.env.PROXY_BASE_HOST;
  if (!PROXY) throw new Error('PROXY_BASE_HOST required');
  return {
    MCP_SERVER_URL: `${PROXY}/proxy/mcp`,
    STORAGE_API_TOKEN: sessionToken,
    STORAGE_API_URL:
      process.env.KBC_CANARY_STORAGE_URL ?? 'https://connection.canary-orion.keboola.dev',
    SDK_MODEL: process.env.SDK_MODEL ?? 'claude-opus-4-8',
    ANTHROPIC_API_KEY: sessionToken,
    ANTHROPIC_BASE_URL: `${PROXY}/proxy/llm`,
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
    ANTHROPIC_VERTEX_BASE_URL: `${PROXY}/proxy/llm/v1`,
    ANTHROPIC_VERTEX_PROJECT_ID: process.env.GOOGLE_VERTEX_PROJECT ?? 'keboola-ai',
    CLOUD_ML_REGION: process.env.GOOGLE_VERTEX_LOCATION ?? 'eu',
    CLAUDE_CODE_MAX_RETRIES: '3',
    SDK_CHAT_ID: 'spike-chat',
  };
}

async function runTurn({ baseUrl, bearer, prompt, env }) {
  let pid = null;
  let lineBuf = '';
  let success = false;
  await streamCommand(
    baseUrl,
    bearer,
    { cmd: 'node', args: [`${RUNTIME_DIR}/entrypoint.js`], env, cwd: WORKSPACE_DIR },
    async (evt) => {
      if (evt.type === 'pid') {
        pid = evt.pid;
        const sres = await fetch(`${baseUrl}/commands/${pid}/stdin`, {
          method: 'POST',
          headers: appHeaders(bearer),
          body: JSON.stringify({ data: JSON.stringify({ prompt }) }),
        });
        if (!sres.ok) {
          console.error(`\n[stdin failed] ${sres.status} ${await sres.text()}`);
          return true;
        }
        return false;
      }
      if (evt.type === 'stderr') {
        process.stderr.write(`[stderr] ${evt.chunk}`);
        return false;
      }
      // Stop (don't hang) on a host spawn-error event or process exit.
      if (evt.type === 'error') {
        console.error('\n[spawn error]', evt.error);
        return true;
      }
      if (evt.type === 'exit') {
        return true;
      }
      if (evt.type !== 'stdout') return false;
      lineBuf += evt.chunk;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(l);
        } catch {
          continue;
        }
        if (msg.type === 'sdk_message' && msg.data?.type === 'assistant') {
          const text = (msg.data.message?.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          if (text) process.stdout.write(text);
        } else if (msg.type === 'sdk_error') {
          console.error('\n[sdk_error]', msg.error);
        } else if (msg.type === 'sdk_approval_request') {
          // Task 9: respond via the /tmp approval file the sandbox polls (auto-approve).
          await writeFile(
            baseUrl,
            bearer,
            `/tmp/approval-response-${msg.toolUseId}.json`,
            JSON.stringify({ toolUseId: msg.toolUseId, approved: true }),
          );
          console.error(`\n[auto-approved] ${msg.toolName} ${msg.toolUseId}`);
        } else if (msg.type === 'sdk_complete') {
          success = msg.success;
          return true;
        }
      }
      return false;
    },
  );
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = cfg();
  const prompt = process.argv[2] ?? 'Say hello in exactly one word.';
  if (process.env.APP_PASSWORD) await loginAppsProxy(c.baseUrl, process.env.APP_PASSWORD);
  await uploadRuntime(c);
  const ip = await discoverContainerIp(c);
  const sessionToken = await mintSession(ip);
  console.log('minted session token:', `${sessionToken.slice(0, 16)}…`);
  const ok = await runTurn({ ...c, prompt, env: buildEnv(sessionToken) });
  console.log(`\n--- turn complete: success=${ok} ---`);
}
