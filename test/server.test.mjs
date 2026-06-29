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
