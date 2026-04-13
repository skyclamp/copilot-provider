import { Readable } from 'node:stream';
import { forwardUpstreamHeaders, getProxyContext, isRecord } from './proxy.js';

export async function proxyResponses(req, res) {
  try {
    const { apiBase, headers } = await getProxyContext();
    const body = isRecord(req.body) ? { ...req.body } : {};

    if (typeof req.headers.accept === 'string' && req.headers.accept.length > 0) {
      headers.Accept = req.headers.accept;
    }

    console.log(`[proxy] responses model=${String(body.model)} stream=${Boolean(body.stream)} effort=${req.body.reasoning?.effort ?? 'none'}`);

    const upstream = await fetch(`${apiBase}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    res.status(upstream.status);
    forwardUpstreamHeaders(upstream, res);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] responses upstream ${upstream.status}: ${errorBody}`);
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
    console.error('[proxy] Responses error:', error);
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'proxy_error', message: String(error) },
      });
    }
  }
}
