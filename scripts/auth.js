/**
 * GitHub Device Flow OAuth — run once to generate .token
 *
 * Usage: bun run scripts/auth.js
 */

import { dirname, resolve } from 'node:path';
import { chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_DEVICE_CODE_URL,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_CLIENT_ID,
  GITHUB_SCOPE,
} from '../src/constants.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = resolve(SCRIPT_DIR, '../.token');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startDeviceFlow() {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPE,
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Device flow failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function pollForToken(deviceCode, interval, expiresIn) {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval || 5;

  while (Date.now() < deadline) {
    await sleep(pollInterval * 1000);

    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const payload = await response.json();

    if (payload.access_token) {
      return payload.access_token;
    }

    if (payload.error === 'authorization_pending') {
      process.stderr.write('.');
      continue;
    }

    if (payload.error === 'slow_down') {
      pollInterval = payload.interval || pollInterval + 5;
      continue;
    }

    throw new Error(`OAuth failed: ${payload.error_description || payload.error}`);
  }

  throw new Error('Device flow expired');
}

// --- Main ---

console.log('Starting GitHub Device Flow OAuth...\n');

const flow = await startDeviceFlow();

console.log(`Open:  ${flow.verification_uri}`);
console.log(`Code:  ${flow.user_code}`);
if (flow.verification_uri_complete) {
  console.log(`\nDirect link: ${flow.verification_uri_complete}`);
}
console.log('\nWaiting for authorization...');

const accessToken = await pollForToken(flow.device_code, flow.interval, flow.expires_in);

await writeFile(TOKEN_FILE, accessToken.trim() + '\n');
await chmod(TOKEN_FILE, 0o600);

console.log(`\n✓ Token saved to .token`);
