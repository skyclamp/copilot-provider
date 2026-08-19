import { buildResponseHeaders, getProxyContext, isRecord, mapModel } from './proxy.ts';
import { pipeAndExtractUsage, requestUsageExtras } from './usage.ts';
import type { RequestContext } from './types.ts';

export async function proxyMessages(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext(req);
    const body = { ...ctx.body };

    if (typeof body.model === 'string') {
      body.model = mapModel(body.model);
    }

    const anthropicBeta = req.headers.get('anthropic-beta');
    if (anthropicBeta) {
      headers['anthropic-beta'] = anthropicBeta;
    }

    const outputConfig = isRecord(body.output_config) ? body.output_config : null;
    const thinking = isRecord(body.thinking) ? body.thinking : null;
    const effort = typeof outputConfig?.effort === 'string' ? (outputConfig.effort as string) : null;

    const thinkingType = typeof thinking?.type === 'string' ? (thinking.type as string) : 'none';
    console.log(
      `[proxy] ${String(body.model)} stream=${Boolean(body.stream)} effort=${effort} thinking=${thinkingType} key=${apiKeyId}`,
    );

    const upstreamResponse = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const upstream = ctx.sessionLogger
      ? await ctx.sessionLogger.response(upstreamResponse)
      : upstreamResponse;

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    if (upstream.body) {
      return pipeAndExtractUsage(upstream, respHeaders, {
        endpoint: 'messages',
        keyId: apiKeyId,
        stream: Boolean(body.stream),
        requestModel: typeof body.model === 'string' ? body.model : null,
        extras: requestUsageExtras(req),
      });
    }

    return new Response(null, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Error:', error);
    const response = new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
    return ctx.sessionLogger ? ctx.sessionLogger.response(response) : response;
  }
}
