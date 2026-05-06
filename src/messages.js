import { forwardUpstreamHeaders, getProxyContext, isRecord, mapModel } from './proxy.js';
import { pickHeaderExtras, pipeAndExtractUsage } from './usage.js';

const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

// Beta flags the upstream Copilot endpoint does not accept. Filtered out
// of the `anthropic-beta` request header before forwarding. Add new
// entries here as they are discovered.
const ANTHROPIC_BETA_BLACKLIST = new Set([
  'context-1m-2025-08-07',
  'advisor-tool-2026-03-01',
]);

export async function proxyMessages(req, res) {
  try {
    const { apiBase, headers } = await getProxyContext();
    const body = isRecord(req.body) ? { ...req.body } : {};

    if (typeof body.model === 'string') {
      body.model = mapModel(body.model);
    }

    // Drop blacklisted beta flags; forward the rest unchanged.
    const upstreamBeta = req.headers['anthropic-beta']
      ?.split(',')
      .map(h => h.trim())
      .filter(h => h && !ANTHROPIC_BETA_BLACKLIST.has(h))
      .join(',');
    if (upstreamBeta) {
      headers['anthropic-beta'] = upstreamBeta;
    }

    const outputConfig = isRecord(body.output_config) ? body.output_config : null;
    const thinking = isRecord(body.thinking) ? body.thinking : null;
    const originalModel = typeof body.model === 'string' ? body.model : null;
    const originalEffort = typeof outputConfig?.effort === 'string' ? outputConfig.effort : null;

    // Resolve the target model + effort purely as locals; nothing on `body`
    // is mutated until the single write-back step below.
    let model = originalModel;
    let effort = originalEffort;

    // Env-driven sub-model routing for the 1M-context variants. Kept here
    // (rather than in MODEL_ALIASES) so that all sub-model logic lives in
    // one place.
    if (model === 'claude-opus-4.6' && process.env.ROUTE_OPUS_4_6_TO_1M === 'true') {
      model = 'claude-opus-4.6-1m';
    } else if (model === 'claude-opus-4.7' && process.env.ROUTE_OPUS_4_7_TO_1M === 'true') {
      model = 'claude-opus-4.7-1m-internal';
    }

    // `claude-opus-4.7` exposes three sub-models keyed by effort:
    //   - claude-opus-4.7        -> medium
    //   - claude-opus-4.7-high   -> high
    //   - claude-opus-4.7-xhigh  -> xhigh
    // Pick the sub-model from the requested effort and coerce the effort
    // to a supported value.
    if (model === 'claude-opus-4.7') {
      if (effort === null) {
        // The Claude API treats a missing effort as `high`.
        model = 'claude-opus-4.7-high';
      } else {
        // Coerce to one of: medium / high / xhigh.
        if (EFFORT_RANK[effort] <= EFFORT_RANK.medium) {
          effort = 'medium';
        } else if (effort === 'max') {
          effort = 'xhigh';
        }
        // Route to the matching sub-model (medium stays on the base model).
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
      // `claude-opus-4.7-1m-internal` only supports up to `xhigh` effort.
      effort = 'xhigh';
    }

    // `claude-opus-4.6{,-1m}` and `claude-sonnet-4.6` top out at `high`.
    if (
      effort === 'max' &&
      (model === 'claude-opus-4.6' || model === 'claude-opus-4.6-1m' || model === 'claude-sonnet-4.6')
    ) {
      effort = 'high';
    }

    // Write back: only touch fields the caller actually provided. If the
    // request had no `output_config`, we leave it absent rather than
    // synthesising one.
    if (model !== originalModel) {
      body.model = model;
    }
    if (effort !== originalEffort && outputConfig !== null) {
      outputConfig.effort = effort;
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
