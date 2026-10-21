import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'capi-token': { type: 'string' },
    'capi-ghe-host': { type: 'string' },
    port: { type: 'string' },
    'disable-client-auth': { type: 'boolean' },
  },
});

// CLI arguments take precedence over environment variables.
if (values['capi-token']) process.env.CAPI_TOKEN = values['capi-token'];
if (values['capi-ghe-host']) process.env.CAPI_GHE_HOST = values['capi-ghe-host'];
if (values['disable-client-auth']) process.env.DISABLE_CLIENT_AUTH = 'true';

// Imported after applying CLI overrides: keys.ts reads DISABLE_CLIENT_AUTH at load time.
const { default: app } = await import('./src/server.ts');

if (!process.env.CAPI_TOKEN) {
  console.error('[server] CAPI token missing. Pass --capi-token or set CAPI_TOKEN (run: npm run auth)');
  process.exit(1);
}

const port = parseInt(values.port || process.env.PORT || '4141', 10);

app.listen(port, () => {
  console.log(`[server] Copilot proxy listening on http://localhost:${port}`);
});
