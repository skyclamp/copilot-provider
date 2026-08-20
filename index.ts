import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import app from './src/server.ts';

const port = parseInt(process.env.PORT || '4141', 10);

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function toWebRequest(req: IncomingMessage): Request {
  const method = req.method || 'GET';
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: requestHeaders(req),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as BodyInit;
    init.duplex = 'half';
  }
  return new Request(`http://${req.headers.host || 'localhost'}${req.url || '/'}`, init);
}

async function sendResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream),
    res,
  );
}

const server = createServer((req, res) => {
  void app.fetch(toWebRequest(req))
    .then(response => sendResponse(response, res))
    .catch(error => {
      console.error('[server] Request failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal server error' }));
    });
});

server.setTimeout(240_000);
server.listen(port, () => {
  console.log(`[server] Copilot proxy listening on http://localhost:${port}`);
});
