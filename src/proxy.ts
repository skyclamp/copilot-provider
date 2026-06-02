import { randomUUID } from 'node:crypto';
import { getCopilotToken, getCopilotApiBaseUrl } from './copilot-token.ts';
import { MODEL_ALIASES } from './constants.ts';
import type { ProxyContext } from './types.ts';

type DeviceInfo = {
  vscodeSessionId: string;
  vscodeMachineId: string;
  editorDeviceId: string;
};

function getDeviceInfo(): DeviceInfo {
  const vscodeSessionId = Bun.env.VSCODE_SESSION_ID;
  const vscodeMachineId = Bun.env.VSCODE_MACHINE_ID;
  const editorDeviceId = Bun.env.EDITOR_DEVICE_ID;
  if (!vscodeSessionId || !vscodeMachineId || !editorDeviceId) {
    throw new Error('Device env vars not set. Run: bun run setup-device');
  }
  return { vscodeSessionId, vscodeMachineId, editorDeviceId };
}

function buildHeaders(copilotToken: string, device: DeviceInfo): Record<string, string> {
  const chatVersion = Bun.env.COPILOT_CHAT_VERSION || '0.41.2';
  const vscodeVersion = Bun.env.VSCODE_VERSION || '1.113.0';
  const apiVersion = Bun.env.GITHUB_API_VERSION || '2025-10-01';

  return {
    Authorization: `Bearer ${copilotToken}`,
    'X-GitHub-Api-Version': apiVersion,
    'VScode-MachineId': device.vscodeMachineId,
    'Editor-Device-Id': device.editorDeviceId,
    'X-Request-Id': randomUUID(),
    'Editor-Plugin-Version': `copilot-chat/${chatVersion}`,
    'Editor-Version': `vscode/${vscodeVersion}`,
  };
}

export function mapModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getProxyContext(): Promise<ProxyContext> {
  const tokenResponse = await getCopilotToken();
  const device = getDeviceInfo();
  return {
    apiBase: getCopilotApiBaseUrl(tokenResponse),
    headers: buildHeaders(tokenResponse.token, device),
  };
}

export function buildResponseHeaders(upstream: Response): Headers {
  const out = new Headers();
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) out.set('x-request-id', requestId);
  const githubRequestId = upstream.headers.get('x-github-request-id');
  if (githubRequestId) out.set('x-github-request-id', githubRequestId);
  const contentType = upstream.headers.get('content-type');
  if (contentType) out.set('Content-Type', contentType);
  return out;
}
