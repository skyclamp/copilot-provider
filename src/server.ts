import { proxyChatCompletions } from './chat-completions.ts';
import { proxyMessages } from './messages.ts';
import { proxyResponses } from './responses.ts';
import { resolveKeyId } from './usage.ts';
import type { EndpointHandler, RequestContext } from './types.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function notFound(method: string, path: string): Response {
  console.log(`[404] ${method} ${path}`);
  return new Response('null', { status: 404, headers: JSON_HEADERS });
}

function rejectUnauthorized(method: string, path: string, authType: string): Response {
  console.log(`[403] ${method} ${path} — invalid ${authType}`);
  return new Response('null', { status: 404, headers: JSON_HEADERS });
}

function resolveProvidedKey(rawKey: string | null | undefined): { ok: true; keyId: string } | { ok: false } {
  if (!rawKey) return { ok: false };
  const keyId = resolveKeyId(rawKey);
  if (keyId) return { ok: true, keyId };
  return { ok: false };
}

type AuthScheme = 'x-api-key' | 'bearer';

function getApiKeyId(req: Request, scheme: AuthScheme): string | null {
  if (Bun.env.DISABLE_INPUT_AUTH === 'true') return 'noauth';
  let raw: string | null;
  if (scheme === 'x-api-key') {
    raw = req.headers.get('x-api-key');
  } else {
    const auth = req.headers.get('authorization') || '';
    raw = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  }
  const result = resolveProvidedKey(raw);
  return result.ok ? result.keyId : null;
}

const ROUTES: Record<string, { handler: EndpointHandler; scheme: AuthScheme; authLabel: string }> = {
  '/v1/messages': { handler: proxyMessages, scheme: 'x-api-key', authLabel: 'api key' },
  '/responses': { handler: proxyResponses, scheme: 'bearer', authLabel: 'authorization' },
  '/chat/completions': { handler: proxyChatCompletions, scheme: 'bearer', authLabel: 'authorization' },
};

async function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === 'HEAD' && (path === '/' || path === '/api/hello')) {
    return new Response(null, { status: 200 });
  }

  if (method === 'POST') {
    const route = ROUTES[path];
    if (route) {
      const apiKeyId = getApiKeyId(req, route.scheme);
      if (!apiKeyId) {
        return rejectUnauthorized(method, path, route.authLabel);
      }

      const ctx: RequestContext = { req, apiKeyId };
      return route.handler(ctx);
    }
  }

  return notFound(method, path);
}

const app = { fetch: dispatch };

export default app;
