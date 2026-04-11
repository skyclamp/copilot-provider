import express from 'express';
import { proxyEmbeddings } from './embeddings.js';
import { proxyMessages } from './messages.js';

const app = express();

app.use(express.json());

function rejectUnauthorized(req, res, authType) {
  console.log(`[403] ${req.method} ${req.path} — invalid ${authType}`);
  res.status(404).json(null);
}

function validateMessagesApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (apiKey && req.headers['x-api-key'] !== apiKey) {
    rejectUnauthorized(req, res, 'api key');
    return;
  }
  next();
}

function validateEmbeddingsAuthorization(req, res, next) {
  const apiKey = process.env.API_KEY;
  const authorization = req.headers.authorization;
  if (apiKey && authorization !== `Bearer ${apiKey}`) {
    rejectUnauthorized(req, res, 'authorization');
    return;
  }
  next();
}

// POST /v1/messages and /v1/embeddings — proxy to Copilot API
app.post('/v1/messages', validateMessagesApiKey, proxyMessages);
app.post('/v1/embeddings', validateEmbeddingsAuthorization, proxyEmbeddings);

// Everything else — 404 + log
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json(null);
});

export default app;
