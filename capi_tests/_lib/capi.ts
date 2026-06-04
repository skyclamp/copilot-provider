/**
 * Tiny CAPI client used by the probes in `capi_tests/`. Independent of `src/` — it
 * exchanges the GitHub token for a Copilot token, then posts directly to the
 * upstream `/v1/messages` endpoint with the headers Copilot expects. Nothing
 * here goes through the local proxy.
 */

import { randomUUID } from 'node:crypto';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_COPILOT_TOKEN_PATH = '/copilot_internal/v2/token';
const TOKEN_API_VERSION = '2025-04-01';
const DEFAULT_COPILOT_API_BASE = 'https://api.githubcopilot.com';

type CopilotTokenResponse = {
  token: string;
  expires_at: number;
  endpoints?: { api?: string };
};

let cachedToken: CopilotTokenResponse | null = null;

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function tokenIsValid(token: CopilotTokenResponse | null): token is CopilotTokenResponse {
  return !!token && typeof token.token === 'string' && token.expires_at > nowInSeconds() + 60;
}

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`Required env var ${name} is not set (loaded from .env)`);
  return value;
}

function gheHost(): string | null {
  const raw = Bun.env.GHE_HOST?.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim();
  return raw ? raw : null;
}

function githubApiBase(): string {
  const ghe = gheHost();
  return ghe ? `https://api.${ghe}` : GITHUB_API_BASE;
}

export async function getCopilotToken(): Promise<CopilotTokenResponse> {
  if (tokenIsValid(cachedToken)) return cachedToken;

  const githubToken = requireEnv('GITHUB_TOKEN');
  const editorDeviceId = Bun.env.EDITOR_DEVICE_ID ?? '';

  const resp = await fetch(`${githubApiBase()}${GITHUB_COPILOT_TOKEN_PATH}`, {
    method: 'GET',
    headers: {
      Authorization: `token ${githubToken}`,
      'X-GitHub-Api-Version': TOKEN_API_VERSION,
      'Editor-Device-Id': editorDeviceId,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Copilot token exchange failed: ${resp.status} ${resp.statusText} — ${body}`);
  }
  const payload = (await resp.json()) as CopilotTokenResponse;
  if (!payload?.token) throw new Error('Copilot token response missing `token`');
  cachedToken = payload;
  return payload;
}

export function getCopilotApiBase(tokenResp: CopilotTokenResponse): string {
  return tokenResp.endpoints?.api?.replace(/\/+$/, '') || DEFAULT_COPILOT_API_BASE;
}

function buildCapiHeaders(copilotToken: string): Record<string, string> {
  const chatVersion = Bun.env.COPILOT_CHAT_VERSION || '0.50.0';
  const vscodeVersion = Bun.env.VSCODE_VERSION || '1.122.0';
  const apiVersion = Bun.env.GITHUB_API_VERSION || '2026-06-01';
  const machineId = requireEnv('VSCODE_MACHINE_ID');
  const deviceId = requireEnv('EDITOR_DEVICE_ID');

  return {
    Authorization: `Bearer ${copilotToken}`,
    'X-GitHub-Api-Version': apiVersion,
    'VScode-MachineId': machineId,
    'Editor-Device-Id': deviceId,
    'X-Request-Id': randomUUID(),
    'Editor-Plugin-Version': `copilot-chat/${chatVersion}`,
    'Editor-Version': `vscode/${vscodeVersion}`,
    'Content-Type': 'application/json',
  };
}

export type CallCapiOptions = {
  /** JSON body for the target CAPI endpoint. */
  body: object;
  /** Set to true to request SSE (Accept: text/event-stream). */
  stream?: boolean;
  /** Extra headers (e.g. `anthropic-beta`, `anthropic-version`). Wins over endpoint defaults. */
  extraHeaders?: Record<string, string>;
};

type CapiCallResult = { resp: Response; url: string; sentHeaders: Record<string, string> };

/**
 * POST {capiBase}/v1/messages directly. Returns the raw fetch Response so the
 * caller can read it as text/json/stream as needed.
 */
export async function callCapiMessages(opts: CallCapiOptions): Promise<CapiCallResult> {
  const tokenResp = await getCopilotToken();
  const apiBase = getCopilotApiBase(tokenResp);
  const url = `${apiBase}/v1/messages`;
  const headers = {
    'anthropic-version': '2023-06-01',
    ...buildCapiHeaders(tokenResp.token),
    ...(opts.stream ? { Accept: 'text/event-stream' } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
  return { resp, url, sentHeaders: headers };
}

/**
 * POST {capiBase}/responses directly. Returns the raw fetch Response so the
 * caller can read it as text/json/stream as needed.
 */
export async function callCapiResponses(opts: CallCapiOptions): Promise<CapiCallResult> {
  const tokenResp = await getCopilotToken();
  const apiBase = getCopilotApiBase(tokenResp);
  const url = `${apiBase}/responses`;
  const headers = {
    ...buildCapiHeaders(tokenResp.token),
    ...(opts.stream ? { Accept: 'text/event-stream' } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
  });
  return { resp, url, sentHeaders: headers };
}
