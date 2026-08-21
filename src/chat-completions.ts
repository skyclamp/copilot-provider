import { buildResponseHeaders, getProxyContext } from './proxy.ts';
import type { RequestContext } from './types.ts';

export async function proxyChatCompletions(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);

    const accept = req.headers.get('accept');
    if (accept) headers.Accept = accept;

    console.log(`[proxy] chat/completions key=${apiKeyId}`);

    const upstream = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: req.body,
    });

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] chat/completions upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Chat completions error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
