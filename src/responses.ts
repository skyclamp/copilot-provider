import { buildResponseHeaders, describeError, getProxyContext } from './proxy.ts';
import { stabilizeResponseStream } from './responses-stream.ts';
import { grokChatHeaders } from './grok.ts';
import { requestProduct } from './session.ts';
import type { RequestContext } from './types.ts';

const CODEX_INTENT = 'responses-proxy';

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

    const body = await req.json() as Record<string, unknown>;
    if (body.model === 'gpt-5.6-sol' && (body.service_tier === 'fast' || body.service_tier === 'priority')) {
      body.model = 'gpt-5.6-sol-fast';
      delete body.service_tier;
    }

    let kind = 'proxy';
    if (product === 'gb') {
      // grok-build: shaped like VS Code Chat agent requests.
      const grok = grokChatHeaders(req, isUserInitiated(body.input));
      kind = grok.kind;
      Object.assign(headers, grok.headers);
    } else {
      // Codex: shaped like VS Code's built-in Responses proxy.
      const userAgent = req.headers.get('user-agent');
      if (userAgent) headers['User-Agent'] = upstreamUserAgent(userAgent);
      headers['OpenAI-Intent'] = CODEX_INTENT;
      headers['X-Interaction-Type'] = CODEX_INTENT;
      headers['X-Initiator'] = isUserInitiated(body.input) ? 'user' : 'agent';
    }

    console.log(`[proxy] model=${body.model} client=${product} kind=${kind} initiator=${headers['X-Initiator']}`);
    const upstream = await fetch(`${apiBase}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
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
    console.error(`[proxy] responses error: ${describeError(error)}`);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: describeError(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
