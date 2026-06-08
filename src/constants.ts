export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_BASE_URL = 'https://api.github.com';
export const GITHUB_COPILOT_TOKEN_PATH = '/copilot_internal/v2/token';
export const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const GITHUB_SCOPE = 'read:user';

function normalizeGheHost(host: string | undefined | null): string | null {
  if (!host) return null;
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim() || null;
}

export function getGheHost(): string | null {
  return normalizeGheHost(Bun.env.GHE_HOST);
}

export function getGitHubApiBaseUrl(): string {
  const ghe = getGheHost();
  return ghe ? `https://api.${ghe}` : GITHUB_API_BASE_URL;
}

export function getGitHubDeviceCodeUrl(): string {
  const ghe = getGheHost();
  return ghe ? `https://${ghe}/login/device/code` : GITHUB_DEVICE_CODE_URL;
}

export function getGitHubAccessTokenUrl(): string {
  const ghe = getGheHost();
  return ghe ? `https://${ghe}/login/oauth/access_token` : GITHUB_ACCESS_TOKEN_URL;
}

export const DEFAULT_COPILOT_API_BASE_URL = 'https://api.githubcopilot.com';
export const TOKEN_API_VERSION = '2025-04-01';

export const MODEL_ALIASES: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4.5',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8',
  'haiku': 'claude-haiku-4.5',
  'sonnet': 'claude-sonnet-4.6',
  'sonnet[1m]': 'claude-sonnet-4.6',
  'opus': 'claude-opus-4.8',
  'opus[1m]': 'claude-opus-4.8',
};
