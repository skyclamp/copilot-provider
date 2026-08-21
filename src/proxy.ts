import { randomUUID } from 'node:crypto';
import { getCopilotToken, getCopilotApiBaseUrl } from './copilot-token.ts';
import { requestSessionIdentity } from './session.ts';
import type { ProxyContext } from './types.ts';

type DeviceInfo = {
  vscodeMachineId: string;
  editorDeviceId: string;
};

function getDeviceInfo(): DeviceInfo {
  const vscodeMachineId = Bun.env.VSCODE_MACHINE_ID;
  const editorDeviceId = Bun.env.EDITOR_DEVICE_ID;
  if (!vscodeMachineId || !editorDeviceId) {
    throw new Error('Device env vars not set. Run: bun run setup-device');
  }
  return { vscodeMachineId, editorDeviceId };
}

function detectAgentSessionId(req: Request | undefined): string | undefined {
  return req ? requestSessionIdentity(req)?.sessionId : undefined;
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
    'Content-Type': 'application/json',
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
