import { buildResponseHeaders, getProxyContext } from './proxy.ts';
import type { RequestContext } from './types.ts';

export async function proxyMessages(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);

    const anthropicBeta = req.headers.get('anthropic-beta');
    if (anthropicBeta) {
      headers['anthropic-beta'] = anthropicBeta;
    }

    console.log(`[proxy] messages key=${apiKeyId}`);

    const upstream = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: req.body,
    });

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
