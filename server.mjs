import express from 'express';
import { bearerAuth } from './lib/auth.mjs';
import { mountFiles } from './lib/files.mjs';

export function createApp({ bearer } = {}) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(bearerAuth(bearer));

  // Platform startup probe: python-js base image POSTs to "/" — must answer 200.
  app.all('/', (_req, res) => res.status(200).send('kai-dataapp-sandbox'));
  app.get('/health', (_req, res) => res.json({ ok: true }));

  mountFiles(app);

  return app;
}

export function startServer(port = Number(process.env.PORT) || 3000) {
  const app = createApp({ bearer: process.env.SANDBOX_BEARER });
  return app.listen(port, '0.0.0.0', () => console.log(`sandbox host on :${port}`));
}

// Boot only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) startServer();
