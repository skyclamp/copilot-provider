import { buildResponseHeaders, getProxyContext, isRecord } from './proxy.ts';
import { pickHeaderExtras, pipeAndExtractUsage } from './usage.ts';
import type { RequestContext } from './types.ts';

export async function proxyResponses(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext();
    const body: Record<string, unknown> = isRecord(ctx.body) ? { ...ctx.body } : {};

    const accept = req.headers.get('accept');
    if (accept) headers.Accept = accept;

    const reasoning = isRecord(body.reasoning) ? body.reasoning : null;
    const effort = typeof reasoning?.effort === 'string' ? reasoning.effort : 'none';
    console.log(
      `[proxy] responses model=${String(body.model)} stream=${Boolean(body.stream)} effort=${effort} key=${apiKeyId}`,
    );

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

    if (upstream.body) {
      const extras = pickHeaderExtras(req.headers, [
        'x-session-id',
        'x-session-affinity',
        'x-opencode-session',
      ]);
      const ua = req.headers.get('user-agent');
      if (ua) extras['user-agent'] = ua;
      return pipeAndExtractUsage(upstream, respHeaders, {
        endpoint: 'responses',
        keyId: apiKeyId,
        stream: Boolean(body.stream),
        requestModel: typeof body.model === 'string' ? body.model : null,
        extras,
      });
    }

    return new Response(null, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Responses error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
