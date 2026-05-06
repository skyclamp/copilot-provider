import {
  GITHUB_COPILOT_TOKEN_PATH,
  TOKEN_API_VERSION,
  DEFAULT_COPILOT_API_BASE_URL,
  getGitHubApiBaseUrl,
} from './constants.js';

let cached = null;

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isTokenValid(token) {
  if (!token?.token || !token?.expires_at) return false;
  return token.expires_at > nowInSeconds() + 60;
}

function readGitHubToken() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set in .env. Run: bun run scripts/auth.js');
  return token;
}

async function exchangeToken(githubToken) {
  const chatVersion = process.env.COPILOT_CHAT_VERSION || '0.41.2';
  const vscodeVersion = process.env.VSCODE_VERSION || '1.113.0';

  const response = await fetch(`${getGitHubApiBaseUrl()}${GITHUB_COPILOT_TOKEN_PATH}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `token ${githubToken}`,
      'User-Agent': `GitHubCopilotChat/${chatVersion}`,
      'X-GitHub-Api-Version': TOKEN_API_VERSION,
      'Editor-Plugin-Version': `copilot-chat/${chatVersion}`,
      'Editor-Version': `vscode/${vscodeVersion}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${body}`);
  }

  const payload = await response.json();
  if (!payload?.token) {
    throw new Error('Copilot token response missing token field');
  }
  return payload;
}

export async function getCopilotToken() {
  if (isTokenValid(cached)) return cached;

  const githubToken = readGitHubToken();
  const token = await exchangeToken(githubToken);
  cached = token;
  console.log(`[copilot-token] Refreshed, expires_at=${token.expires_at}, api=${token.endpoints?.api}`);
  return token;
}

export function getCopilotApiBaseUrl(tokenResponse) {
  return tokenResponse.endpoints?.api?.replace(/\/+$/, '') || DEFAULT_COPILOT_API_BASE_URL;
}
