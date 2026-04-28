import express from 'express';
import { proxyEmbeddings } from './embeddings.js';
import { proxyMessages } from './messages.js';
import { proxyResponses } from './responses.js';
import { resolveKeyId } from './usage.js';

const app = express();

app.use(express.json({ limit: '20mb' }));

function rejectUnauthorized(req, res, authType) {
  console.log(`[403] ${req.method} ${req.path} — invalid ${authType}`);
  res.status(404).json(null);
}

// Accepts any key listed in src/keys.json. Attaches req.apiKeyId for usage tracking.
function resolveProvidedKey(rawKey) {
  if (!rawKey) return { ok: false };
  const keyId = resolveKeyId(rawKey);
  if (keyId) return { ok: true, keyId };
  return { ok: false };
}

function validateMessagesApiKey(req, res, next) {
  if (process.env.DISABLE_INPUT_AUTH === 'true') {
    req.apiKeyId = 'noauth';
    return next();
  }
  const result = resolveProvidedKey(req.headers['x-api-key']);
  if (result.ok) {
    req.apiKeyId = result.keyId;
    return next();
  }
  rejectUnauthorized(req, res, 'api key');
}

function validateOpenAIAuthorization(req, res, next) {
  if (process.env.DISABLE_INPUT_AUTH === 'true') {
    req.apiKeyId = 'noauth';
    return next();
  }
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const result = resolveProvidedKey(bearer);
  if (result.ok) {
    req.apiKeyId = result.keyId;
    return next();
  }
  rejectUnauthorized(req, res, 'authorization');
}

// HEAD / — health check
app.head('/', (req, res) => {
  res.status(200).end();
});

// POST /v1/messages, /v1/responses, and /v1/embeddings — proxy to Copilot API
app.post('/v1/messages', validateMessagesApiKey, proxyMessages);
app.post('/v1/responses', validateOpenAIAuthorization, proxyResponses);
app.post('/v1/embeddings', validateOpenAIAuthorization, proxyEmbeddings);

// Everything else — 404 + log
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json(null);
});

export default app;
