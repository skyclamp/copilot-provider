import express from 'express';
import { proxyMessages } from './proxy';

const app = express();

app.use(express.json({ limit: '10mb' }));

// POST /v1/messages — proxy to Copilot API
app.post('/v1/messages', proxyMessages);

// Everything else — 404 + log
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not Found' });
});

export default app;
