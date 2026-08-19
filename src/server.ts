import { proxyChatCompletions } from './chat-completions.ts';
import { proxyMessages } from './messages.ts';
import { proxyResponses } from './responses.ts';
import { createSessionEventLogger } from './session-log.ts';
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

class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 415,
  ) {
    super(message);
  }
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!isJsonContentType(contentType)) {
    throw new RequestBodyError('content-type must be application/json', 415);
  }
  const text = await req.text();
  if (!text) throw new RequestBodyError('request body must be a JSON object', 400);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestBodyError('invalid json', 400);
  }
  if (!isJsonObject(value)) {
    throw new RequestBodyError('request body must be a JSON object', 400);
  }
  return value;
}

const ROUTES: Record<string, { handler: EndpointHandler; scheme: AuthScheme; authLabel: string }> = {
  '/v1/messages': { handler: proxyMessages, scheme: 'x-api-key', authLabel: 'api key' },
  '/v1/responses': { handler: proxyResponses, scheme: 'bearer', authLabel: 'authorization' },
  '/v1/chat/completions': { handler: proxyChatCompletions, scheme: 'bearer', authLabel: 'authorization' },
};

async function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const sessionLogger = createSessionEventLogger(req);
  sessionLogger?.request(method, path);
  const respond = (response: Response): Promise<Response> =>
    sessionLogger ? sessionLogger.response(response) : Promise.resolve(response);

  if (method === 'HEAD' && path === '/') {
    return respond(new Response(null, { status: 200 }));
  }

  if (method === 'POST') {
    const route = ROUTES[path];
    if (route) {
      const apiKeyId = getApiKeyId(req, route.scheme);
      if (!apiKeyId) {
        return respond(rejectUnauthorized(method, path, route.authLabel));
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonObject(req);
      } catch (error) {
        const bodyError = error instanceof RequestBodyError
          ? error
          : new RequestBodyError('invalid json', 400);
        return respond(new Response(JSON.stringify({ error: bodyError.message }), {
          status: bodyError.status,
          headers: JSON_HEADERS,
        }));
      }

      const ctx: RequestContext = { req, body, apiKeyId, sessionLogger };
      return route.handler(ctx);
    }
  }

  return respond(notFound(method, path));
}

const app = { fetch: dispatch };

export default app;
