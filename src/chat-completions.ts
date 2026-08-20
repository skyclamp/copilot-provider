import { buildResponseHeaders, getProxyContext } from './proxy.ts';
import { pipeAndExtractUsage, requestUsageExtras } from './usage.ts';
import type { RequestContext } from './types.ts';

export async function proxyChatCompletions(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);
    const body = { ...ctx.body };

    const accept = req.headers.get('accept');
    if (accept) headers.Accept = accept;

    console.log(
      `[proxy] chat/completions model=${String(body.model)} stream=${Boolean(body.stream)} key=${apiKeyId}`,
    );

    const upstream = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] chat/completions upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    if (upstream.body) {
      return pipeAndExtractUsage(upstream, respHeaders, {
        endpoint: 'chat/completions',
        keyId: apiKeyId,
        stream: Boolean(body.stream),
        requestModel: typeof body.model === 'string' ? body.model : null,
        extras: requestUsageExtras(req),
      });
    }

    return new Response(null, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Chat completions error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
