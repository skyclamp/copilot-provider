import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import express from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { describeError } from './proxy.ts';
import { proxyResponses } from './responses.ts';
import { resolveKeyId } from './keys.ts';
import type { RequestContext } from './types.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function notFound(method: string, path: string): Response {
  console.log(`[404] ${method} ${path}`);
  return new Response('null', { status: 404, headers: JSON_HEADERS });
}

function rejectUnauthorized(method: string, path: string): Response {
  console.log(`[403] ${method} ${path} — invalid authorization`);
  return new Response('null', { status: 404, headers: JSON_HEADERS });
}

function getApiKeyId(req: Request): string | null {
  if (process.env.DISABLE_CLIENT_AUTH === 'true') return 'noauth';
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? resolveKeyId(auth.slice(7)) : null;
}

async function handleResponses(req: Request): Promise<Response> {
  const apiKeyId = getApiKeyId(req);
  if (!apiKeyId) {
    return rejectUnauthorized(req.method, new URL(req.url).pathname);
  }

  const ctx: RequestContext = { req, apiKeyId };
  return proxyResponses(ctx);
}

// Endpoint handlers work on Web Request/Response; these adapt Express to them.
// The request body is streamed, not parsed, and a client disconnect aborts
// `req.signal` so the upstream fetch is cancelled too.
function toWebRequest(req: ExpressRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    duplex: 'half',
    signal,
  });
}

// Rejects when the upstream body fails (e.g. undici's 300s body timeout) and
// resolves when the response finishes or the client goes away. Unlike
// `pipeline`, a body error leaves `res` open so the caller can tell it apart
// from a client disconnect.
function sendWebResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return Promise.resolve();
  }
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  return new Promise((resolve, reject) => {
    body.once('error', reject);
    res.once('finish', resolve);
    res.once('close', () => {
      body.destroy();
      resolve();
    });
    body.pipe(res);
  });
}

function route(handler: (req: Request) => Promise<Response>) {
  return async (req: ExpressRequest, res: ExpressResponse) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      await sendWebResponse(res, await handler(toWebRequest(req, controller.signal)));
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(`[server] ${req.method} ${req.path} failed: ${describeError(error)}`);
      if (!res.headersSent) {
        res.status(502).set(JSON_HEADERS)
          .send(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: describeError(error) } }));
      } else {
        // Status is already sent; cutting the connection lets the client see
        // an incomplete stream instead of a truncated success.
        res.destroy();
      }
    }
  };
}

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// Also answers HEAD. grok-build prewarms the connection with an
// unauthenticated `GET /` on the base URL's origin when a session starts.
app.get('/', (_req, res) => {
  res.status(200).end();
});
app.post('/responses', route(handleResponses));
app.use(route(async req => notFound(req.method, new URL(req.url).pathname)));

export default app;
