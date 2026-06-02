import { buildResponseHeaders, getProxyContext, isRecord, mapModel } from './proxy.ts';
import { pickHeaderExtras, pipeAndExtractUsage } from './usage.ts';
import type { RequestContext } from './types.ts';

const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

// Prefixes of `anthropic-beta` flags the upstream Copilot endpoint accepts.
// Sourced from the vscode codebase at
// `src/vs/platform/agentHost/node/claude/anthropicBetas.ts`.
const ANTHROPIC_BETA_PREFIX_WHITELIST = [
  'interleaved-thinking',
  'context-management',
  'advanced-tool-use',
];

function isAllowedAnthropicBeta(flag: string): boolean {
  return ANTHROPIC_BETA_PREFIX_WHITELIST.some(
    prefix => flag === prefix || flag.startsWith(`${prefix}-`),
  );
}

export async function proxyMessages(ctx: RequestContext): Promise<Response> {
  try {
    const { req, apiKeyId } = ctx;
    const { apiBase, headers } = await getProxyContext();
    const body: Record<string, unknown> = isRecord(ctx.body) ? { ...ctx.body } : {};

    if (typeof body.model === 'string') {
      body.model = mapModel(body.model);
    }

    const upstreamBeta = req.headers.get('anthropic-beta')
      ?.split(',')
      .map(h => h.trim())
      .filter(h => h && isAllowedAnthropicBeta(h))
      .join(',');
    if (upstreamBeta) {
      headers['anthropic-beta'] = upstreamBeta;
    }

    const outputConfig = isRecord(body.output_config) ? body.output_config : null;
    const thinking = isRecord(body.thinking) ? body.thinking : null;
    const originalModel = typeof body.model === 'string' ? body.model : null;
    const originalEffort = typeof outputConfig?.effort === 'string' ? (outputConfig.effort as string) : null;

    let model = originalModel;
    let effort = originalEffort;

    if (model === 'claude-opus-4.6' && Bun.env.ROUTE_OPUS_4_6_TO_1M === 'true') {
      model = 'claude-opus-4.6-1m';
    } else if (model === 'claude-opus-4.7' && Bun.env.ROUTE_OPUS_4_7_TO_1M === 'true') {
      model = 'claude-opus-4.7-1m-internal';
    }

    if (model === 'claude-opus-4.7') {
      if (effort === null) {
        model = 'claude-opus-4.7-high';
      } else {
        if (EFFORT_RANK[effort] <= EFFORT_RANK.medium) {
          effort = 'medium';
        } else if (effort === 'max') {
          effort = 'xhigh';
        }
        if (effort === 'high') {
          model = 'claude-opus-4.7-high';
        } else if (effort === 'xhigh') {
          model = 'claude-opus-4.7-xhigh';
        }
      }
    } else if (
      model === 'claude-opus-4.7-1m-internal' &&
      effort !== null &&
      EFFORT_RANK[effort] > EFFORT_RANK.xhigh
    ) {
      effort = 'xhigh';
    }

    if (
      effort === 'max' &&
      (model === 'claude-opus-4.6' || model === 'claude-opus-4.6-1m' || model === 'claude-sonnet-4.6')
    ) {
      effort = 'high';
    }

    if (model !== originalModel) {
      body.model = model;
    }
    if (effort !== originalEffort && outputConfig !== null) {
      outputConfig.effort = effort;
    }

    const thinkingType = typeof thinking?.type === 'string' ? (thinking.type as string) : 'none';
    console.log(
      `[proxy] ${String(body.model)} stream=${Boolean(body.stream)} effort=${originalEffort} thinking=${thinkingType} key=${apiKeyId}`,
    );

    const upstream = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const respHeaders = buildResponseHeaders(upstream);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }

    if (upstream.body) {
      const extras = pickHeaderExtras(req.headers, [
        'x-claude-code-session-id',
        'x-session-affinity',
        'x-opencode-session',
      ]);
      const ua = req.headers.get('user-agent');
      if (ua) extras['user-agent'] = ua;
      return pipeAndExtractUsage(upstream, respHeaders, {
        endpoint: 'messages',
        keyId: apiKeyId,
        stream: Boolean(body.stream),
        requestModel: typeof body.model === 'string' ? body.model : null,
        extras,
      });
    }

    return new Response(null, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    console.error('[proxy] Error:', error);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String(error) } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
