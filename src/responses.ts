import { buildResponseHeaders, getProxyContext } from './proxy.ts';
import type { RequestContext } from './types.ts';

export async function proxyResponses(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);

    const accept = req.headers.get('accept');
    if (accept) headers.Accept = accept;

    console.log(`[proxy] responses key=${apiKeyId}`);

    const body = await req.json() as Record<string, unknown>;
    if (body.model === 'gpt-5.6-sol' && (body.service_tier === 'fast' || body.service_tier === 'priority')) {
      body.model = 'gpt-5.6-sol-fast';
      delete body.service_tier;
    }
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

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Responses error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
