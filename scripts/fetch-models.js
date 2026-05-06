#!/usr/bin/env node
/**
 * Standalone Copilot models fetcher.
 *
 * Takes a GitHub access token, exchanges it for a Copilot token (prints the
 * exchange response as JSON), then calls /models and prints that response as
 * JSON. Supports github.com (default) and GitHub Enterprise (--ghe-host).
 *
 * Usage:
 *   bun run scripts/fetch-models.js --token <github-token> [OPTIONS]
 */

import { randomUUID } from 'node:crypto';

import {
  GITHUB_API_BASE_URL,
  GITHUB_COPILOT_TOKEN_PATH,
  TOKEN_API_VERSION,
  DEFAULT_COPILOT_API_BASE_URL,
} from '../src/constants.js';

const MODELS_API_VERSION = '2025-10-01';
const COPILOT_INTEGRATION_ID = 'vscode-chat';

function parseArgs(argv) {
  const args = {
    token: process.env.GITHUB_TOKEN || null,
    gheHost: null,
    copilotApiBaseUrl: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if ((a === '--token' || a === '--github-token') && i + 1 < argv.length) {
      args.token = argv[++i];
    } else if ((a === '--ghe-host' || a === '--enterprise-host') && i + 1 < argv.length) {
      args.gheHost = argv[++i].replace(/^https?:\/\//, '').replace(/\/+$/, '');
    } else if (a === '--copilot-api-base-url' && i + 1 < argv.length) {
      args.copilotApiBaseUrl = argv[++i].replace(/\/+$/, '');
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage: bun run scripts/fetch-models.js --token <github-token> [OPTIONS]',
    '',
    'Exchanges a GitHub access token for a Copilot token, prints that response',
    'as JSON, then calls the Copilot /models endpoint and prints that as JSON.',
    '',
    'Options:',
    '  --token <token>             GitHub access token (or set GITHUB_TOKEN env).',
    '  --github-token <token>      Alias of --token.',
    '  --ghe-host <host>           GitHub Enterprise host (e.g. github.enterprise.com).',
    '                              Omit for github.com.',
    '  --copilot-api-base-url <url>',
    '                              Override the Copilot API base URL.',
    '  -h, --help                  Show this help.',
  ].join('\n'));
}

function getGitHubApiBaseUrl(gheHost) {
  if (gheHost) {
    // GHE Copilot token endpoint lives on the api.<host> subdomain,
    // e.g. https://api.ghe.example.com/copilot_internal/v2/token
    return `https://api.${gheHost}`;
  }
  return GITHUB_API_BASE_URL;
}

function getEditorVersions() {
  const chatVersion = process.env.COPILOT_CHAT_VERSION || '0.41.2';
  const vscodeVersion = process.env.VSCODE_VERSION || '1.113.0';
  return {
    userAgent: `GitHubCopilotChat/${chatVersion}`,
    editorVersion: `vscode/${vscodeVersion}`,
    editorPluginVersion: `copilot-chat/${chatVersion}`,
  };
}

function tokenExchangeHeaders(githubToken) {
  const v = getEditorVersions();
  return {
    Accept: 'application/json',
    Authorization: `token ${githubToken}`,
    'User-Agent': v.userAgent,
    'X-GitHub-Api-Version': TOKEN_API_VERSION,
    'Editor-Version': v.editorVersion,
    'Editor-Plugin-Version': v.editorPluginVersion,
  };
}

function modelsHeaders(copilotToken) {
  const v = getEditorVersions();
  return {
    Authorization: `Bearer ${copilotToken}`,
    'User-Agent': v.userAgent,
    'X-GitHub-Api-Version': MODELS_API_VERSION,
    'VScode-SessionId': randomUUID(),
    'VScode-MachineId': randomUUID(),
    'Editor-Device-Id': randomUUID(),
    'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
    'OpenAI-Intent': 'model-access',
    'Editor-Version': v.editorVersion,
    'Editor-Plugin-Version': v.editorPluginVersion,
  };
}

async function exchangeForCopilotToken({ githubApiBaseUrl, githubToken }) {
  const response = await fetch(`${githubApiBaseUrl}${GITHUB_COPILOT_TOKEN_PATH}`, {
    method: 'GET',
    headers: tokenExchangeHeaders(githubToken),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to exchange GitHub token for Copilot token: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Copilot token exchange returned non-JSON response: ${text}`);
  }

  if (!payload || typeof payload.token !== 'string' || !payload.token.trim()) {
    throw new Error(`Copilot token response missing 'token': ${text}`);
  }

  return payload;
}

async function fetchModels({ copilotApiBaseUrl, copilotToken }) {
  const response = await fetch(`${copilotApiBaseUrl}/models`, {
    method: 'GET',
    headers: modelsHeaders(copilotToken),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Failed to fetch /models: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`/models returned non-JSON response: ${text}`);
  }
}

// --- Main ---

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  printHelp();
  process.exit(2);
}

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args.token) {
  console.error('Missing GitHub token. Pass --token <token> or set GITHUB_TOKEN.');
  printHelp();
  process.exit(2);
}

const githubApiBaseUrl = getGitHubApiBaseUrl(args.gheHost);

const copilotTokenResponse = await exchangeForCopilotToken({
  githubApiBaseUrl,
  githubToken: args.token,
});

console.log(JSON.stringify(copilotTokenResponse, null, 2));

const copilotApiBaseUrl =
  args.copilotApiBaseUrl ||
  (copilotTokenResponse.endpoints?.api
    ? String(copilotTokenResponse.endpoints.api).replace(/\/+$/, '')
    : DEFAULT_COPILOT_API_BASE_URL);

const modelsResponse = await fetchModels({
  copilotApiBaseUrl,
  copilotToken: copilotTokenResponse.token,
});

console.log(JSON.stringify(modelsResponse, null, 2));
