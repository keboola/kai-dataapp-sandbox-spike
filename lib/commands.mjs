import { spawn } from 'node:child_process';

export const registry = new Map(); // pid -> { child, subscribers:Set<res> }

export function spawnCommand({ cmd, args = [], env = {}, cwd }) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const handle = { child, subscribers: new Set() };
  registry.set(child.pid, handle);

  const fanout = (type) => (data) => {
    const msg = `data: ${JSON.stringify({ type, chunk: data.toString('utf8') })}\n\n`;
    for (const res of handle.subscribers) res.write(msg);
  };
  child.stdout.on('data', fanout('stdout'));
  child.stderr.on('data', fanout('stderr'));
  // A spawn failure (e.g. ENOENT for a missing binary) surfaces asynchronously as
  // an 'error' event, not a throw. Without this listener Node treats it as an
  // unhandled 'error' and can crash the process; no 'exit' fires, so the SSE
  // response would hang. Fan out an error event, end subscribers, drop the entry.
  child.on('error', (err) => {
    const msg = `data: ${JSON.stringify({ type: 'error', error: String(err.message ?? err) })}\n\n`;
    for (const res of handle.subscribers) {
      res.write(msg);
      res.end();
    }
    registry.delete(child.pid);
  });
  child.on('exit', (code) => {
    const msg = `data: ${JSON.stringify({ type: 'exit', code })}\n\n`;
    for (const res of handle.subscribers) {
      res.write(msg);
      res.end();
    }
    registry.delete(child.pid);
  });
  return handle;
}

export function mountCommands(app) {
  app.post('/commands', (req, res) => {
    const { cmd, args, env, cwd } = req.body;
    // setHeader (not res.set/res.type) keeps the bare media type — Express would
    // otherwise append "; charset=utf-8" to a text/* content type.
    res.setHeader('Content-Type', 'text/event-stream');
    res.set({
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no', // belt-and-braces against proxy buffering
    });
    res.flushHeaders?.();
    let handle;
    try {
      handle = spawnCommand({ cmd, args, env, cwd });
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({ type: 'error', error: String(err.message ?? err) })}\n\n`,
      );
      return res.end();
    }
    res.write(`data: ${JSON.stringify({ type: 'pid', pid: handle.child.pid })}\n\n`);
    handle.subscribers.add(res);
    // Drop the subscriber when the *response* stream closes (client disconnect).
    // NB: req.on('close') fires as soon as the POST body is consumed — for a
    // buffered JSON body that is immediate, which would unsubscribe before the
    // child emits anything and hang the stream. res.on('close') is the correct signal.
    res.on('close', () => handle.subscribers.delete(res));
  });

  // Re-attach to a still-running child (kai-agent reconnects each turn). Live
  // fan-out only — no replay; the caller attaches BEFORE sending the next stdin
  // prompt, so no output for that turn is missed (same order E2B uses).
  app.get('/commands/:pid/stream', (req, res) => {
    const handle = registry.get(Number(req.params.pid));
    if (!handle) return res.status(404).json({ error: 'no such pid' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.set({
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: 'pid', pid: handle.child.pid })}\n\n`);
    handle.subscribers.add(res);
    // res.on('close' (not req.on) is the client-disconnect signal — same reasoning
    // as the POST /commands handler above.
    res.on('close', () => handle.subscribers.delete(res));
  });

  app.post('/commands/:pid/stdin', (req, res) => {
    const handle = registry.get(Number(req.params.pid));
    if (!handle) return res.status(404).json({ error: 'no such pid' });
    const data = String(req.body.data ?? '');
    handle.child.stdin.write(data.endsWith('\n') ? data : data + '\n');
    res.json({ ok: true });
  });

  app.delete('/commands/:pid', (req, res) => {
    const handle = registry.get(Number(req.params.pid));
    if (!handle) return res.status(404).json({ error: 'no such pid' });
    handle.child.kill('SIGTERM');
    res.json({ ok: true });
  });
}
