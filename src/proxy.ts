import { randomUUID } from 'node:crypto';
import { getCopilotToken, getCopilotApiBaseUrl } from './copilot-token.ts';
import { MODEL_ALIASES } from './constants.ts';
import type { ProxyContext } from './types.ts';

type DeviceInfo = {
  vscodeMachineId: string;
  editorDeviceId: string;
};

const AGENT_SESSION_HEADERS = [
  'x-claude-code-session-id', // claude code
  'session-id', // codex
  'x-session-affinity', // opencode
];

function getDeviceInfo(): DeviceInfo {
  const vscodeMachineId = Bun.env.VSCODE_MACHINE_ID;
  const editorDeviceId = Bun.env.EDITOR_DEVICE_ID;
  if (!vscodeMachineId || !editorDeviceId) {
    throw new Error('Device env vars not set. Run: bun run setup-device');
  }
  return { vscodeMachineId, editorDeviceId };
}

function detectAgentSessionId(req: Request | undefined): string | undefined {
  if (!req) return undefined;
  for (const name of AGENT_SESSION_HEADERS) {
    const value = req.headers.get(name);
    if (value) return value;
  }
  return undefined;
}

function buildHeaders(
  copilotToken: string,
  device: DeviceInfo,
  agentSessionId: string | undefined,
): Record<string, string> {
  const chatVersion = Bun.env.COPILOT_CHAT_VERSION || '0.41.2';
  const vscodeVersion = Bun.env.VSCODE_VERSION || '1.113.0';
  const apiVersion = Bun.env.GITHUB_API_VERSION || '2025-10-01';

  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilotToken}`,
    'X-GitHub-Api-Version': apiVersion,
    'VScode-MachineId': device.vscodeMachineId,
    'Editor-Device-Id': device.editorDeviceId,
    'X-Request-Id': randomUUID(),
    'Editor-Plugin-Version': `copilot-chat/${chatVersion}`,
    'Editor-Version': `vscode/${vscodeVersion}`,
  };
  if (agentSessionId) {
    headers['VScode-SessionId'] = agentSessionId;
  }
  return headers;
}

export function mapModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getProxyContext(req?: Request): Promise<ProxyContext> {
  const tokenResponse = await getCopilotToken();
  const device = getDeviceInfo();
  const agentSessionId = detectAgentSessionId(req);
  return {
    apiBase: getCopilotApiBaseUrl(tokenResponse),
    headers: buildHeaders(tokenResponse.token, device, agentSessionId),
  };
}

export function buildResponseHeaders(upstream: Response): Headers {
  const out = new Headers();
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) out.set('x-request-id', requestId);
  const contentType = upstream.headers.get('content-type');
  if (contentType) out.set('Content-Type', contentType);
  return out;
}
