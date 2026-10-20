import { buildResponseHeaders, getProxyContext } from './proxy.ts';
import { stabilizeResponseStream } from './responses-stream.ts';
import { requestProduct } from './session.ts';
import type { RequestContext } from './types.ts';

const CODEX_INTENT = 'responses-proxy';
const CHAT_INTENT = 'conversation-agent';

function isUserInitiated(input: unknown): boolean {
  const last = Array.isArray(input) ? input.at(-1) : input;
  if (typeof last === 'string') return true;
  if (!last || typeof last !== 'object') return false;
  const item = last as { type?: unknown; role?: unknown };
  return (item.type === undefined || item.type === 'message') && item.role === 'user';
}

function upstreamUserAgent(userAgent: string): string {
  const slash = userAgent.indexOf('/');
  return slash === -1 ? `vscode_codex/${userAgent}` : `vscode_codex${userAgent.slice(slash)}`;
}

export async function proxyResponses(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);

    const accept = req.headers.get('accept');
    if (accept) headers.Accept = accept;
    const product = requestProduct(req);
    let intent = CHAT_INTENT;
    if (product !== 'gb') {
      const userAgent = req.headers.get('user-agent');
      if (userAgent) headers['User-Agent'] = upstreamUserAgent(userAgent);
      intent = CODEX_INTENT;
    }
    headers['OpenAI-Intent'] = intent;
    headers['X-Interaction-Type'] = intent;

    console.log(`[proxy] responses key=${apiKeyId} client=${product}`);

    const body = await req.json() as Record<string, unknown>;
    if (body.model === 'gpt-5.6-sol' && (body.service_tier === 'fast' || body.service_tier === 'priority')) {
      body.model = 'gpt-5.6-sol-fast';
      delete body.service_tier;
    }
    headers['X-Initiator'] = isUserInitiated(body.input) ? 'user' : 'agent';
    const upstream = await fetch(`${apiBase}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] responses upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    const responseBody = upstream.body && upstream.headers.get('content-type')?.includes('text/event-stream')
      ? stabilizeResponseStream(upstream.body)
      : upstream.body;
    return new Response(responseBody, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Responses error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
