import express from 'express';
import { proxyMessages } from './proxy';

const app = express();

app.use(express.json({ limit: '10mb' }));

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

// POST /v1/messages — proxy to Copilot API
app.post('/v1/messages', proxyMessages);

// Everything else — 404 + log
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json(null);
});

export default app;
