#!/usr/bin/env bun
/**
 * GitHub Device Flow OAuth — prints GITHUB_TOKEN for .env
 *
 * Usage: bun run scripts/auth.ts
 */

import {
  GITHUB_CLIENT_ID,
  GITHUB_SCOPE,
  getGitHubDeviceCodeUrl,
  getGitHubAccessTokenUrl,
  getGheHost,
} from '../src/constants.ts';

const GITHUB_DEVICE_CODE_URL = getGitHubDeviceCodeUrl();
const GITHUB_ACCESS_TOKEN_URL = getGitHubAccessTokenUrl();

type DeviceFlowStart = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

type DeviceFlowPoll = {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function startDeviceFlow(): Promise<DeviceFlowStart> {
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

  const payload = (await response.json()) as DeviceFlowStart & { error?: string };
  if (!response.ok) {
    throw new Error(`Device flow failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function pollForToken(deviceCode: string, interval: number, expiresIn: number): Promise<string> {
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

    const payload = (await response.json()) as DeviceFlowPoll;

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

const gheHost = getGheHost();
console.log(`Starting GitHub Device Flow OAuth${gheHost ? ` (GHE: ${gheHost})` : ''}...\n`);

const flow = await startDeviceFlow();

console.log(`Open:  ${flow.verification_uri}`);
console.log(`Code:  ${flow.user_code}`);
if (flow.verification_uri_complete) {
  console.log(`\nDirect link: ${flow.verification_uri_complete}`);
}
console.log('\nWaiting for authorization...');

const accessToken = await pollForToken(flow.device_code, flow.interval, flow.expires_in);

console.log('\n# GitHub token (paste into .env)');
console.log(`GITHUB_TOKEN=${accessToken.trim()}`);
