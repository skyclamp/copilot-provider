import { randomUUID } from 'node:crypto';
import { getCopilotToken, getCopilotApiBaseUrl } from './copilot-token.ts';
import { upstreamSessionId } from './session.ts';
import type { ProxyContext } from './types.ts';

const interactionId = randomUUID();

const FORWARDED_RESPONSE_HEADERS = ['x-request-id', 'x-github-request-id', 'retry-after', 'retry-after-ms', 'x-should-retry'];
const FORWARDED_RESPONSE_HEADER_PREFIXES = ['x-quota-snapshot-', 'x-usage-ratelimit-'];

type DeviceInfo = {
  vscodeMachineId: string;
  editorDeviceId: string;
};

function getDeviceInfo(): DeviceInfo {
  const vscodeMachineId = process.env.VSCODE_MACHINE_ID;
  const editorDeviceId = process.env.EDITOR_DEVICE_ID;
  if (!vscodeMachineId || !editorDeviceId) {
    throw new Error('Device env vars not set. Run: npm run setup-device');
  }
  return { vscodeMachineId, editorDeviceId };
}

function buildHeaders(
  copilotToken: string,
  device: DeviceInfo,
  sessionId: string,
): Record<string, string> {
  const chatVersion = process.env.COPILOT_CHAT_VERSION || '0.70.0';
  const vscodeVersion = process.env.VSCODE_VERSION || '1.142.0';
  const apiVersion = process.env.GITHUB_API_VERSION || '2026-08-01';
  const requestId = randomUUID();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${copilotToken}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': apiVersion,
    'VScode-SessionId': sessionId,
    'VScode-MachineId': device.vscodeMachineId,
    'Editor-Device-Id': device.editorDeviceId,
    'X-Request-Id': requestId,
    'X-Agent-Task-Id': requestId,
    'X-Interaction-Id': interactionId,
    'Editor-Plugin-Version': `copilot-chat/${chatVersion}`,
    'Editor-Version': `vscode/${vscodeVersion}`,
    'User-Agent': `GitHubCopilotChat/${chatVersion}`,
  };
  return headers;
}

export async function getProxyContext(req?: Request): Promise<ProxyContext> {
  const tokenResponse = await getCopilotToken();
  const device = getDeviceInfo();
  return {
    apiBase: getCopilotApiBaseUrl(tokenResponse),
    headers: buildHeaders(tokenResponse.token, device, upstreamSessionId(req)),
  };
}

export function describeError(error: unknown): string {
  const cause = error instanceof Error && error.cause ? `: ${String(error.cause)}` : '';
  return `${String(error)}${cause}`;
}

export function buildResponseHeaders(upstream: Response): Headers {
  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (
      FORWARDED_RESPONSE_HEADERS.includes(name) ||
      FORWARDED_RESPONSE_HEADER_PREFIXES.some(prefix => name.startsWith(prefix))
    ) {
      out.set(name, value);
    }
  }
  const contentType = upstream.headers.get('content-type');
  if (contentType) out.set('Content-Type', contentType);
  return out;
}
