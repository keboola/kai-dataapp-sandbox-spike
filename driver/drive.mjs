import fs from 'node:fs';
import path from 'node:path';

const RUNTIME_DIR = '/opt/kai-agent';

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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ path: p, data }),
  });
  if (!res.ok) throw new Error(`write ${p} failed: ${res.status} ${await res.text()}`);
}

function collectRuntimeFiles(distDir) {
  const files = [{ name: 'package.json', content: '{"type":"module"}\n' }];
  for (const name of fs.readdirSync(distDir).sort()) {
    if (name.endsWith('.js') && name !== 'index.js') {
      files.push({ name, content: fs.readFileSync(path.join(distDir, name), 'utf8') });
    }
  }
  // Skills: siblings of dist/ → skills/ and vendored-skills/
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = cfg();
  await uploadRuntime(c);
  const res = await fetch(`${c.baseUrl}/files/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.bearer}` },
    body: JSON.stringify({ path: '/opt/kai-agent' }),
  });
  console.log(await res.json());
}
