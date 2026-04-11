import { Readable } from 'node:stream';
import { forwardUpstreamHeaders, getProxyContext, isRecord, mapModel } from './proxy.js';

export async function proxyMessages(req, res) {
  try {
    const { apiBase, headers } = await getProxyContext();
    const body = isRecord(req.body) ? { ...req.body } : {};

    if (typeof body.model === 'string') {
      body.model = mapModel(body.model);
    }

    headers['anthropic-beta'] = req.headers['anthropic-beta'];

    const outputConfig = isRecord(body.output_config) ? body.output_config : null;
    const thinking = isRecord(body.thinking) ? body.thinking : null;
    const effort = typeof outputConfig?.effort === 'string' ? outputConfig.effort : 'high';
    const thinkingType = typeof thinking?.type === 'string' ? thinking.type : 'none';
    console.log(
      `[proxy] ${String(body.model)} stream=${Boolean(body.stream)} effort=${effort} thinking=${thinkingType}`,
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
      res.flushHeaders();
      const readable = Readable.fromWeb(upstream.body);
      readable.pipe(res);
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
