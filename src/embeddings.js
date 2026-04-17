import { forwardUpstreamHeaders, getProxyContext, isRecord } from './proxy.js';
import { pipeAndExtractUsage } from './usage.js';

export async function proxyEmbeddings(req, res) {
  try {
    const { apiBase, headers } = await getProxyContext();
    const body = isRecord(req.body) ? { ...req.body } : {};

    const inputCount = Array.isArray(body.input)
      ? body.input.length
      : typeof body.input === 'string'
        ? 1
        : 0;
    console.log(
      `[proxy] embeddings model=${String(body.model)} inputs=${inputCount} dimensions=${body.dimensions ?? 'default'} key=${req.apiKeyId ?? 'anon'}`,
    );

    const upstream = await fetch(`${apiBase}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    res.status(upstream.status);
    forwardUpstreamHeaders(upstream, res);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] embeddings upstream ${upstream.status}: ${errorBody}`);
      res.send(errorBody);
      return;
    }

    if (upstream.body) {
      await pipeAndExtractUsage(upstream, res, {
        endpoint: 'embeddings',
        keyId: req.apiKeyId,
        stream: false,
        requestModel: typeof body.model === 'string' ? body.model : null,
      });
      return;
    }

    res.end();
  } catch (error) {
    console.error('[proxy] Embeddings error:', error);
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'proxy_error', message: String(error) },
      });
    }
  }
}
