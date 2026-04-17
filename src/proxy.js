import { randomUUID } from 'node:crypto';
import { getCopilotToken, getCopilotApiBaseUrl } from './copilot-token.js';
import { MODEL_ALIASES } from './constants.js';

function getDeviceInfo() {
  const vscodeSessionId = process.env.VSCODE_SESSION_ID;
  const vscodeMachineId = process.env.VSCODE_MACHINE_ID;
  const editorDeviceId = process.env.EDITOR_DEVICE_ID;
  if (!vscodeSessionId || !vscodeMachineId || !editorDeviceId) {
    throw new Error('Device env vars not set. Run: bun run scripts/setup-device.js');
  }
  return { vscodeSessionId, vscodeMachineId, editorDeviceId };
}

function buildHeaders(copilotToken, device) {
  const chatVersion = process.env.COPILOT_CHAT_VERSION || '0.41.2';
  const vscodeVersion = process.env.VSCODE_VERSION || '1.113.0';
  const apiVersion = process.env.GITHUB_API_VERSION || '2025-10-01';

  return {
    Authorization: `Bearer ${copilotToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `GitHubCopilotChat/${chatVersion}`,
    'X-GitHub-Api-Version': apiVersion,
    'VScode-SessionId': device.vscodeSessionId,
    'VScode-MachineId': device.vscodeMachineId,
    'Editor-Device-Id': device.editorDeviceId,
    'Copilot-Integration-Id': 'vscode-chat',
    'OpenAI-Intent': 'conversation-agent',
    'X-Interaction-Type': 'conversation',
    'X-Request-Id': randomUUID(),
    'Editor-Plugin-Version': `copilot-chat/${chatVersion}`,
    'Editor-Version': `vscode/${vscodeVersion}`,
  };
}

export function mapModel(model) {
  return MODEL_ALIASES[model] || model;
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getProxyContext() {
  const tokenResponse = await getCopilotToken();
  const device = getDeviceInfo();
  return {
    apiBase: getCopilotApiBaseUrl(tokenResponse),
    headers: buildHeaders(tokenResponse.token, device),
  };
}

export function forwardUpstreamIds(upstream, res) {
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) {
    res.setHeader('x-request-id', requestId);
  }

  const githubRequestId = upstream.headers.get('x-github-request-id');
  if (githubRequestId) {
    res.setHeader('x-github-request-id', githubRequestId);
  }
}

export function forwardUpstreamHeaders(upstream, res) {
  forwardUpstreamIds(upstream, res);
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
}
