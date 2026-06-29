import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_ROOTS = ['/opt/kai-agent', '/home/user/workspace', '/tmp', os.tmpdir()];
const roots = (process.env.SANDBOX_FILE_ROOTS?.split(':').filter(Boolean) ?? DEFAULT_ROOTS).map(
  (r) => path.resolve(r),
);

function assertAllowed(p) {
  if (!path.isAbsolute(p)) throw new Error('path must be absolute');
  const resolved = path.resolve(p);
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error(`path outside allowed roots: ${resolved}`);
  }
  return resolved;
}

export function mountFiles(app) {
  app.post('/files/write', async (req, res) => {
    try {
      const target = assertAllowed(req.body.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const buf = Buffer.from(
        req.body.data ?? '',
        req.body.encoding === 'base64' ? 'base64' : 'utf8',
      );
      await fs.writeFile(target, buf);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message ?? err) });
    }
  });

  app.post('/files/read', async (req, res) => {
    try {
      const target = assertAllowed(req.body.path);
      res.json({ data: await fs.readFile(target, 'utf8') });
    } catch (err) {
      res.status(400).json({ error: String(err.message ?? err) });
    }
  });

  app.post('/files/remove', async (req, res) => {
    try {
      const target = assertAllowed(req.body.path);
      await fs.rm(target, { recursive: true, force: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err.message ?? err) });
    }
  });

  app.post('/files/list', async (req, res) => {
    try {
      const target = assertAllowed(req.body.path);
      const entries = await fs.readdir(target, { withFileTypes: true });
      res.json({
        entries: entries.map((e) => ({
          path: path.join(target, e.name),
          type: e.isDirectory() ? 'dir' : 'file',
        })),
      });
    } catch (err) {
      res.status(400).json({ error: String(err.message ?? err) });
    }
  });
}
