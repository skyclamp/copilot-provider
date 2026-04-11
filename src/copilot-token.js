import { dirname, resolve } from 'node:path';
import { readFile, writeFile, chmod, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  GITHUB_API_BASE_URL,
  GITHUB_COPILOT_TOKEN_PATH,
  TOKEN_API_VERSION,
  DEFAULT_COPILOT_API_BASE_URL,
} from './constants.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = resolve(MODULE_DIR, '..', '.token');
const COPILOT_FILE = resolve(MODULE_DIR, '..', '.copilot');

let cached = null;

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isTokenValid(token) {
  if (!token?.token || !token?.expires_at) return false;
  return token.expires_at > nowInSeconds() + 60;
}

async function readGitHubToken() {
  try {
    await access(TOKEN_FILE);
  } catch {
    throw new Error('.token not found. Run: bun run scripts/auth.js');
  }
  const token = (await readFile(TOKEN_FILE, 'utf-8')).trim();
  if (!token) throw new Error('.token file is empty');
  return token;
}

async function readCachedCopilotToken() {
  try {
    await access(COPILOT_FILE);
    const content = await readFile(COPILOT_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeCopilotToken(token) {
  await writeFile(COPILOT_FILE, JSON.stringify(token, null, 2) + '\n');
  await chmod(COPILOT_FILE, 0o600);
}

async function exchangeToken(githubToken) {
  const chatVersion = process.env.COPILOT_CHAT_VERSION || '0.41.2';
  const vscodeVersion = process.env.VSCODE_VERSION || '1.113.0';

  const response = await fetch(`${GITHUB_API_BASE_URL}${GITHUB_COPILOT_TOKEN_PATH}`, {
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

  // Try file cache on cold start
  if (!cached) {
    const fromFile = await readCachedCopilotToken();
    if (isTokenValid(fromFile)) {
      cached = fromFile;
      console.log(`[copilot-token] Loaded from .copilot, expires_at=${cached.expires_at}`);
      return cached;
    }
  }

  // Exchange for new token
  const githubToken = await readGitHubToken();
  const token = await exchangeToken(githubToken);
  cached = token;
  await writeCopilotToken(token);
  console.log(`[copilot-token] Refreshed, expires_at=${token.expires_at}, api=${token.endpoints?.api}`);
  return token;
}

export function getCopilotApiBaseUrl(tokenResponse) {
  return tokenResponse.endpoints?.api?.replace(/\/+$/, '') || DEFAULT_COPILOT_API_BASE_URL;
}
