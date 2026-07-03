// M2 deploy helper for the AI-3434 spike. Talks to the canary data-science (Sandbox Service)
// API to create a managed-git python-js data app, mint git creds, deploy, and inspect state.
// Usage: DS_BASE=... KBC_CANARY_TOKEN=... node driver/deploy.mjs <subcommand> [args]

const DS_BASE = process.env.DS_BASE ?? 'https://data-science.canary-orion.keboola.dev';
const TOKEN = process.env.KBC_CANARY_TOKEN;
if (!TOKEN) throw new Error('KBC_CANARY_TOKEN required (source canary.env)');

const H = { 'content-type': 'application/json', 'x-storageapi-token': TOKEN };

export async function api(method, p, body) {
  const res = await fetch(`${DS_BASE}${p}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { _raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${p} → ${res.status}\n${JSON.stringify(parsed, null, 2)}`);
  }
  return parsed;
}

export async function createManagedApp(name = 'kai-sandbox-spike') {
  const app = await api('POST', '/apps', {
    type: 'python-js',
    branchId: null,
    name,
    useManagedGitRepo: true,
    mode: 'prod',
  });
  console.log('CREATED APP:\n', JSON.stringify(app, null, 2));
  return app;
}

export async function makeCred(appId) {
  const cred = await api('POST', `/apps/${appId}/git-repo/credentials`, {
    type: 'http_token',
    permissions: 'readWrite',
  });
  console.log('CREDENTIAL (one-time secret):\n', JSON.stringify(cred, null, 2));
  return cred;
}

export async function getRepo(appId) {
  const repo = await api('GET', `/apps/${appId}/git-repo`);
  console.log('GIT REPO:\n', JSON.stringify(repo, null, 2));
  return repo;
}

export async function status(appId) {
  const app = await api('GET', `/apps/${appId}`);
  console.log('APP:\n', JSON.stringify(app, null, 2));
  const runs = await api('GET', `/apps/${appId}/runs`).catch((e) => ({ error: String(e) }));
  console.log('RUNS:\n', JSON.stringify(runs, null, 2));
  return { app, runs };
}

export async function deploy(appId, configVersion) {
  const body = configVersion
    ? { desiredState: 'running', restartIfRunning: true, configVersion }
    : { desiredState: 'running' };
  const r = await api('PATCH', `/apps/${appId}`, body);
  console.log('DEPLOY PATCH:\n', JSON.stringify(r, null, 2));
  return r;
}

export async function logs(appId) {
  const res = await fetch(`${DS_BASE}/apps/${appId}/logs/tail`, { headers: H });
  console.log(`[HTTP ${res.status}]\n` + (await res.text()));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, arg, arg2] = process.argv.slice(2);
  const fns = { create: () => createManagedApp(arg), creds: () => makeCred(arg), repo: () => getRepo(arg), status: () => status(arg), deploy: () => deploy(arg, arg2), logs: () => logs(arg) };
  const fn = fns[cmd];
  if (!fn) {
    console.error('subcommands: create [name] | creds <appId> | repo <appId> | status <appId> | deploy <appId> [configVersion] | logs <appId>');
    process.exit(2);
  }
  await fn();
}
