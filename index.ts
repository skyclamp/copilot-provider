import app from './src/server.ts';

const port = parseInt(Bun.env.PORT || '4141', 10);

const server = Bun.serve({
  port,
  fetch: app.fetch,
  idleTimeout: 240,
});

console.log(`[server] Copilot proxy listening on http://localhost:${server.port}`);
