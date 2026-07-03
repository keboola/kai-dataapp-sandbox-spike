import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

let server, base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('GET /health returns ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('POST / (startup probe) returns 200', async () => {
  const res = await fetch(`${base}/`, { method: 'POST' });
  assert.equal(res.status, 200);
});

test('files write then read round-trips', async () => {
  const p = path.join(os.tmpdir(), 'kai-spike-roundtrip.txt');
  const w = await fetch(`${base}/files/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: p, data: 'hello' }),
  });
  assert.equal(w.status, 200);
  const r = await fetch(`${base}/files/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: p }),
  });
  assert.deepEqual(await r.json(), { data: 'hello' });
});

test('files write rejects disallowed root', async () => {
  const res = await fetch(`${base}/files/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: '/etc/passwd', data: 'x' }),
  });
  assert.equal(res.status, 400);
});

test('POST /commands streams stdout and a pid', async () => {
  const res = await fetch(`${base}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'node', args: ['-e', "process.stdout.write('hi\\n')"] }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await readSse(res, (evt) => evt.type === 'exit');
  assert.ok(text.some((e) => e.type === 'pid' && typeof e.pid === 'number'));
  assert.ok(text.some((e) => e.type === 'stdout' && e.chunk.includes('hi')));
});

test('stdin is delivered to the child and echoed on stdout', async () => {
  const res = await fetch(`${base}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cmd: 'node',
      args: [
        '-e',
        "let b='';process.stdin.on('data',d=>{b+=d;if(b.includes('\\n')){process.stdout.write('echo:'+b);process.exit(0);}})",
      ],
    }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  // read the pid event
  const first = JSON.parse(dec.decode((await reader.read()).value).split('data: ')[1]);
  assert.equal(first.type, 'pid');
  await fetch(`${base}/commands/${first.pid}/stdin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'ping' }),
  });
  let got = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    got += dec.decode(value);
    if (got.includes('echo:ping')) break;
  }
  assert.ok(got.includes('echo:ping'));
  await reader.cancel();
});

test('POST /commands with a bogus cmd streams an error event and ends', async () => {
  // Bound the request: without a child.on('error') handler the SSE stream never
  // ends, so readSse would hang forever. The AbortController turns that hang into
  // a prompt, deterministic failure instead of a runner timeout / leaked socket.
  const ctrl = new AbortController();
  const guard = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${base}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'definitely-not-a-real-binary-xyz' }),
      signal: ctrl.signal,
    });
    const events = await readSse(res, (evt) => evt.type === 'error');
    assert.ok(events.some((e) => e.type === 'error' && typeof e.error === 'string'));
  } finally {
    clearTimeout(guard);
  }
});

test('GET /commands/:pid/stream re-attaches to a running child', async () => {
  // Spawn a child that prints after a delay so a second subscriber can attach
  // before any output is produced, then confirm the re-attached GET stream gets
  // a pid event followed by the live stdout chunk.
  const res = await fetch(`${base}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd: 'sh', args: ['-c', 'sleep 0.2; echo hi'] }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const first = JSON.parse(dec.decode((await reader.read()).value).split('data: ')[1]);
  assert.equal(first.type, 'pid');
  const attached = await fetch(`${base}/commands/${first.pid}/stream`);
  assert.equal(attached.headers.get('content-type'), 'text/event-stream');
  const events = await readSse(attached, (evt) => evt.type === 'stdout');
  assert.ok(events.some((e) => e.type === 'pid' && e.pid === first.pid));
  const out = events.find((e) => e.type === 'stdout');
  assert.match(out.chunk, /hi/);
  await reader.cancel();
});

test('GET /commands/:pid/stream 404s for unknown pid', async () => {
  const res = await fetch(`${base}/commands/999999/stream`);
  assert.equal(res.status, 404);
});

test('POST /files/read returns base64 when requested', async () => {
  const p = path.join(os.tmpdir(), 'kai-test-bin');
  await fetch(`${base}/files/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: p, data: 'AAEC', encoding: 'base64' }),
  });
  const res = await fetch(`${base}/files/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: p, encoding: 'base64' }),
  });
  assert.equal((await res.json()).data, 'AAEC');
});

test('bearer auth blocks missing token but allows health', async () => {
  const app = createApp({ bearer: 'secret' });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  assert.equal((await fetch(`${b}/health`)).status, 200); // exempt
  assert.equal(
    (
      await fetch(`${b}/files/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"path":"/tmp"}',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${b}/files/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: '{"path":"/tmp"}',
      })
    ).status,
    200,
  );
  s.close();
});

// helper: read SSE data lines until `done(evt)` true or stream ends
async function readSse(res, done) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const evt = JSON.parse(line.slice(6));
      events.push(evt);
      if (done(evt)) {
        await reader.cancel();
        return events;
      }
    }
  }
  return events;
}
