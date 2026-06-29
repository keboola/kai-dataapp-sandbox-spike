import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
