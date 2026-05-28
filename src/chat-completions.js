import { forwardUpstreamHeaders, getProxyContext, isRecord } from './proxy.js';
import { pickHeaderExtras, pipeAndExtractUsage } from './usage.js';

export async function proxyChatCompletions(req, res) {
  try {
    const { apiBase, headers } = await getProxyContext();
    const body = isRecord(req.body) ? { ...req.body } : {};

    if (typeof req.headers.accept === 'string' && req.headers.accept.length > 0) {
      headers.Accept = req.headers.accept;
    }

    console.log(`[proxy] chat/completions model=${String(body.model)} stream=${Boolean(body.stream)} key=${req.apiKeyId ?? 'anon'}`);

    const upstream = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    res.status(upstream.status);
    forwardUpstreamHeaders(upstream, res);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] chat/completions upstream ${upstream.status}: ${errorBody}`);
      res.send(errorBody);
      return;
    }

    if (upstream.body) {
      const extras = pickHeaderExtras(req.headers, [
        'x-session-id',
        'x-session-affinity',
        'x-opencode-session',
      ]);
      if (typeof req.headers['user-agent'] === 'string') {
        extras['user-agent'] = req.headers['user-agent'];
      }
      await pipeAndExtractUsage(upstream, res, {
        endpoint: 'chat/completions',
        keyId: req.apiKeyId,
        stream: Boolean(body.stream),
        requestModel: typeof body.model === 'string' ? body.model : null,
        extras,
      });
      return;
    }

    res.end();
  } catch (error) {
    console.error('[proxy] Chat completions error:', error);
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'proxy_error', message: String(error) },
      });
    }
  }
}
