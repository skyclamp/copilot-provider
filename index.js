import 'dotenv/config';
import app from './src/server.js';

const port = parseInt(process.env.PORT || '4141', 10);

app.listen(port, () => {
  console.log(`[server] Copilot proxy listening on http://localhost:${port}`);
});
