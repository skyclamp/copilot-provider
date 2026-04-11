import { SUPPORTED_EMBEDDING_MODEL } from './constants.js';
import { forwardUpstreamIds, getProxyContext, isRecord } from './proxy.js';

function createOpenAIError(
  message,
  param,
  code,
  type = 'invalid_request_error',
) {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

function sendOpenAIError(
  res,
  status,
  message,
  param,
  code,
  type = 'invalid_request_error',
) {
  res.status(status).json(createOpenAIError(message, param, code, type));
}

function normalizeEmbeddingsInput(input) {
  if (typeof input === 'string') {
    return input.length > 0 ? [input] : null;
  }

  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }

  if (!input.every((item) => typeof item === 'string' && item.length > 0)) {
    return null;
  }

  return input;
}

function normalizeEmbeddingsDimensions(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }

  return value;
}

function parseUpstreamError(body, status) {
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        return createOpenAIError(
          parsed.error.message,
          typeof parsed.error.param === 'string' ? parsed.error.param : null,
          typeof parsed.error.code === 'string' ? parsed.error.code : null,
          typeof parsed.error.type === 'string'
            ? parsed.error.type
            : status >= 500
              ? 'api_error'
              : 'invalid_request_error',
        );
      }
    } catch {
      // Embeddings upstream often returns plain text errors.
    }
  }

  return createOpenAIError(
    body || `Upstream request failed with status ${status}.`,
    null,
    null,
    status >= 500 ? 'api_error' : 'invalid_request_error',
  );
}

function normalizeEmbeddingItem(item, index) {
  if (isRecord(item) && Array.isArray(item.embedding)) {
    return {
      ...item,
      index: typeof item.index === 'number' ? item.index : index,
      object: item.object === 'embedding' ? item.object : 'embedding',
    };
  }

  if (Array.isArray(item)) {
    return {
      embedding: item,
      index,
      object: 'embedding',
    };
  }

  return null;
}

function normalizeEmbeddingsResponse(body) {
  if (!isRecord(body)) {
    return null;
  }

  const rawData = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.embeddings)
      ? body.embeddings
      : null;

  if (!rawData) {
    return null;
  }

  const data = rawData
    .map((item, index) => normalizeEmbeddingItem(item, index))
    .filter((item) => item !== null);

  if (data.length !== rawData.length) {
    return null;
  }

  const response = {
    object: 'list',
    data,
    model: SUPPORTED_EMBEDDING_MODEL,
  };

  if (isRecord(body.usage)) {
    const promptTokens = body.usage.prompt_tokens;
    const totalTokens = body.usage.total_tokens;
    if (typeof promptTokens === 'number' && typeof totalTokens === 'number') {
      response.usage = {
        prompt_tokens: promptTokens,
        total_tokens: totalTokens,
      };
    }
  }

  return response;
}

export async function proxyEmbeddings(req, res) {
  const body = isRecord(req.body) ? req.body : {};

  if (typeof body.model !== 'string' || body.model.length === 0) {
    sendOpenAIError(
      res,
      400,
      `The model field is required and must be "${SUPPORTED_EMBEDDING_MODEL}".`,
      'model',
      'invalid_model',
    );
    return;
  }

  if (body.model !== SUPPORTED_EMBEDDING_MODEL) {
    sendOpenAIError(
      res,
      400,
      `Unsupported model "${body.model}". This endpoint only supports "${SUPPORTED_EMBEDDING_MODEL}".`,
      'model',
      'invalid_model',
    );
    return;
  }

  const normalizedInput = normalizeEmbeddingsInput(body.input);
  if (!normalizedInput) {
    sendOpenAIError(
      res,
      400,
      'The input field must be a non-empty string or a non-empty array of non-empty strings.',
      'input',
      'unsupported_input_type',
    );
    return;
  }

  if (body.encoding_format !== undefined && body.encoding_format !== 'float') {
    sendOpenAIError(
      res,
      400,
      'Only encoding_format "float" is supported for this endpoint.',
      'encoding_format',
      'unsupported_encoding_format',
    );
    return;
  }

  if (body.user !== undefined && typeof body.user !== 'string') {
    sendOpenAIError(
      res,
      400,
      'The user field must be a string when provided.',
      'user',
      'invalid_user',
    );
    return;
  }

  const dimensions = normalizeEmbeddingsDimensions(body.dimensions);
  if (dimensions === null) {
    sendOpenAIError(
      res,
      400,
      'The dimensions field must be a positive integer when provided.',
      'dimensions',
      'invalid_dimensions',
    );
    return;
  }

  try {
    const { apiBase, headers } = await getProxyContext();
    const upstreamBody = {
      input: normalizedInput,
      model: body.model,
    };

    if (dimensions !== undefined) {
      upstreamBody.dimensions = dimensions;
    }

    console.log(
      `[proxy] ${body.model} embeddings inputs=${normalizedInput.length} dimensions=${dimensions ?? 'default'}`,
    );

    const upstream = await fetch(`${apiBase}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });

    forwardUpstreamIds(upstream, res);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] embeddings upstream ${upstream.status}: ${errorBody}`);
      res.status(upstream.status).json(parseUpstreamError(errorBody, upstream.status));
      return;
    }

    const rawBody = await upstream.text();
    let parsedBody;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      console.error(`[proxy] embeddings upstream returned invalid JSON: ${rawBody}`);
      sendOpenAIError(
        res,
        502,
        'Upstream embeddings response was not valid JSON.',
        null,
        'invalid_upstream_response',
        'api_error',
      );
      return;
    }

    const normalizedResponse = normalizeEmbeddingsResponse(parsedBody);
    if (!normalizedResponse) {
      console.error('[proxy] embeddings upstream response missing expected embedding data');
      sendOpenAIError(
        res,
        502,
        'Upstream embeddings response was missing expected embedding data.',
        null,
        'invalid_upstream_response',
        'api_error',
      );
      return;
    }

    res.status(200).json(normalizedResponse);
  } catch (error) {
    console.error('[proxy] Embeddings error:', error);
    if (!res.headersSent) {
      sendOpenAIError(res, 502, String(error), null, 'proxy_error', 'api_error');
    }
  }
}
