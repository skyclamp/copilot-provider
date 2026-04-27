import { forwardUpstreamHeaders, getProxyContext, isRecord, mapModel } from './proxy.js';
import { pickHeaderExtras, pipeAndExtractUsage } from './usage.js';

const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

export async function proxyMessages(req, res) {
  try {
    const { apiBase, headers } = await getProxyContext();
    const body = isRecord(req.body) ? { ...req.body } : {};

    if (typeof body.model === 'string') {
      body.model = mapModel(body.model);
    }

    // All models now support 1M context implicitly; the upstream does not
    // accept the `context-1m-2025-08-07` beta header, so strip it but
    // otherwise forward the rest of `anthropic-beta` unchanged.
    const upstreamBeta = req.headers['anthropic-beta']
      ?.split(',')
      .map(h => h.trim())
      .filter(h => h && h !== 'context-1m-2025-08-07')
      .join(',');
    if (upstreamBeta) {
      headers['anthropic-beta'] = upstreamBeta;
    }

    const outputConfig = isRecord(body.output_config) ? body.output_config : null;
    const thinking = isRecord(body.thinking) ? body.thinking : null;
    const originalEffort = typeof outputConfig?.effort === 'string' ? outputConfig.effort : null;
    let effort = originalEffort;
    // `claude-opus-4.7` only supports up to `medium` effort; silently cap when an
    // explicit effort above `medium` was provided. Do not introduce an effort field
    // if the caller did not set one.
    if (
      body.model === 'claude-opus-4.7' &&
      originalEffort !== null &&
      EFFORT_RANK[originalEffort] > EFFORT_RANK.medium
    ) {
      effort = 'medium';
      outputConfig.effort = 'medium';
    }
    // `claude-opus-4.7-1m-internal` only supports up to `xhigh` effort
    if (
      body.model === 'claude-opus-4.7-1m-internal' &&
      originalEffort !== null &&
      EFFORT_RANK[originalEffort] > EFFORT_RANK.xhigh
    ) {
      effort = 'xhigh';
      outputConfig.effort = 'xhigh';
    }
    const thinkingType = typeof thinking?.type === 'string' ? thinking.type : 'none';
    console.log(
      `[proxy] ${String(body.model)} stream=${Boolean(body.stream)} effort=${originalEffort} thinking=${thinkingType} key=${req.apiKeyId ?? 'anon'}`,
    );

    const upstream = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    res.status(upstream.status);
    forwardUpstreamHeaders(upstream, res);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] upstream ${upstream.status}: ${errorBody}`);
      res.send(errorBody);
      return;
    }

    if (upstream.body) {
      const extras = pickHeaderExtras(req.headers, [
        'x-claude-code-session-id',
        'x-session-affinity',
        'x-opencode-session',
      ]);
      if (typeof req.headers['user-agent'] === 'string') {
        extras['user-agent'] = req.headers['user-agent'];
      }
      await pipeAndExtractUsage(upstream, res, {
        endpoint: 'messages',
        keyId: req.apiKeyId,
        stream: Boolean(body.stream),
        requestModel: typeof body.model === 'string' ? body.model : null,
        extras,
      });
      return;
    }

    res.end();
  } catch (error) {
    console.error('[proxy] Error:', error);
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'proxy_error', message: String(error) },
      });
    }
  }
}
