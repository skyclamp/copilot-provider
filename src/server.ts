import express from 'express';
import { proxyEmbeddings } from './embeddings';
import { proxyMessages } from './messages';

const app = express();

app.use(express.json());

// Validate x-api-key header against API_KEY from .env
app.use((req, res, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey && req.headers['x-api-key'] !== apiKey) {
    console.log(`[403] ${req.method} ${req.path} — invalid api key`);
    res.status(404).json(null);
    return;
  }
  next();
});

// POST /v1/messages and /v1/embeddings — proxy to Copilot API
app.post('/v1/messages', proxyMessages);
app.post('/v1/embeddings', proxyEmbeddings);

// Everything else — 404 + log
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json(null);
});

export default app;
