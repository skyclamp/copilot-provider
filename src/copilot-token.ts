import {
  GITHUB_COPILOT_TOKEN_PATH,
  TOKEN_API_VERSION,
  DEFAULT_COPILOT_API_BASE_URL,
  getGitHubApiBaseUrl,
} from './constants.ts';
import type { CopilotTokenResponse } from './types.ts';

let cached: CopilotTokenResponse | null = null;
let refreshInFlight: Promise<CopilotTokenResponse> | null = null;

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isTokenValid(token: CopilotTokenResponse | null): token is CopilotTokenResponse {
  if (!token?.token || !token?.expires_at) return false;
  return token.expires_at > nowInSeconds() + 60;
}

function readGitHubToken(): string {
  const token = Bun.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set in .env. Run: bun run auth');
  return token;
}

async function exchangeToken(githubToken: string): Promise<CopilotTokenResponse> {
  const response = await fetch(`${getGitHubApiBaseUrl()}${GITHUB_COPILOT_TOKEN_PATH}`, {
    method: 'GET',
    headers: {
      Authorization: `token ${githubToken}`,
      'X-GitHub-Api-Version': TOKEN_API_VERSION,
      'Editor-Device-Id': Bun.env.EDITOR_DEVICE_ID || '',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = (await response.json()) as CopilotTokenResponse;
  if (!payload?.token) {
    throw new Error('Copilot token response missing token field');
  }
  return payload;
}

export async function getCopilotToken(): Promise<CopilotTokenResponse> {
  if (isTokenValid(cached)) return cached;
  if (refreshInFlight) return refreshInFlight;

  const githubToken = readGitHubToken();
  const refresh = exchangeToken(githubToken).then(token => {
    cached = token;
    console.log(`[copilot-token] Refreshed, expires_at=${token.expires_at}, api=${token.endpoints?.api}`);
    return token;
  });
  refreshInFlight = refresh;
  try {
    return await refresh;
  } finally {
    if (refreshInFlight === refresh) refreshInFlight = null;
  }
}

export function getCopilotApiBaseUrl(tokenResponse: CopilotTokenResponse): string {
  return tokenResponse.endpoints?.api?.replace(/\/+$/, '') || DEFAULT_COPILOT_API_BASE_URL;
}
