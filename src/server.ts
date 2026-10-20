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
  if (Bun.env.DISABLE_INPUT_AUTH === 'true') return 'noauth';
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? resolveKeyId(auth.slice(7)) : null;
}

async function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === 'HEAD' && path === '/') {
    return new Response(null, { status: 200 });
  }

  if (method === 'POST' && path === '/responses') {
    const apiKeyId = getApiKeyId(req);
    if (!apiKeyId) {
      return rejectUnauthorized(method, path);
    }

    const ctx: RequestContext = { req, apiKeyId };
    return proxyResponses(ctx);
  }

  return notFound(method, path);
}

const app = { fetch: dispatch };

export default app;
