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

// Accepts either the legacy env API_KEY or any key listed in src/keys.json.
// Attaches req.apiKeyId for usage tracking.
function resolveProvidedKey(rawKey) {
  if (!rawKey) return { ok: false };
  const keyId = resolveKeyId(rawKey);
  if (keyId) return { ok: true, keyId };
  const envKey = process.env.API_KEY;
  if (envKey && rawKey === envKey) return { ok: true, keyId: 'env' };
  return { ok: false };
}

function validateMessagesApiKey(req, res, next) {
  const envKey = process.env.API_KEY;
  const header = req.headers['x-api-key'];
  // If neither env key nor any keys.json is required, allow through (back-compat).
  const result = resolveProvidedKey(header);
  if (result.ok) {
    req.apiKeyId = result.keyId;
    return next();
  }
  if (!envKey) {
    // No env key set and header didn't match keys.json — still reject so usage can be attributed.
    rejectUnauthorized(req, res, 'api key');
    return;
  }
  rejectUnauthorized(req, res, 'api key');
}

function validateOpenAIAuthorization(req, res, next) {
  const envKey = process.env.API_KEY;
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const result = resolveProvidedKey(bearer);
  if (result.ok) {
    req.apiKeyId = result.keyId;
    return next();
  }
  if (!envKey) {
    rejectUnauthorized(req, res, 'authorization');
    return;
  }
  rejectUnauthorized(req, res, 'authorization');
}

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
