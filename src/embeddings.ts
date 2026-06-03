import { buildResponseHeaders, getProxyContext, isRecord } from './proxy.ts';
import { pipeAndExtractUsage } from './usage.ts';
import type { RequestContext } from './types.ts';

export async function proxyEmbeddings(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);
    const body: Record<string, unknown> = isRecord(ctx.body) ? { ...ctx.body } : {};

    const inputCount = Array.isArray(body.input)
      ? body.input.length
      : typeof body.input === 'string'
        ? 1
        : 0;
    console.log(
      `[proxy] embeddings model=${String(body.model)} inputs=${inputCount} dimensions=${body.dimensions ?? 'default'} key=${apiKeyId}`,
    );

    const upstream = await fetch(`${apiBase}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] embeddings upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    if (upstream.body) {
      return pipeAndExtractUsage(upstream, respHeaders, {
        endpoint: 'embeddings',
        keyId: apiKeyId,
        stream: false,
        requestModel: typeof body.model === 'string' ? body.model : null,
      });
    }

    return new Response(null, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Embeddings error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
