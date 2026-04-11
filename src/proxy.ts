import { resolve } from 'node:path';
import { readFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { getCopilotToken, getCopilotApiBaseUrl } from './copilot-token';
import { MODEL_ALIASES } from './constants';

const DEVICE_FILE = resolve(__dirname ?? import.meta.dir, '..', '.device');

interface DeviceInfo {
  vscodeSessionId: string;
  vscodeMachineId: string;
  editorDeviceId: string;
}

export interface ProxyContext {
  apiBase: string;
  headers: Record<string, string>;
}

let deviceInfo: DeviceInfo | null = null;

async function getDeviceInfo(): Promise<DeviceInfo> {
  if (deviceInfo) return deviceInfo;
  try {
    await access(DEVICE_FILE);
  } catch {
    throw new Error(`.device not found. Run: bun run scripts/setup-device.ts`);
  }
  const content = await readFile(DEVICE_FILE, 'utf-8');
  deviceInfo = JSON.parse(content);
  return deviceInfo!;
}

function buildHeaders(copilotToken: string, device: DeviceInfo): Record<string, string> {
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

export function mapModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getProxyContext(): Promise<ProxyContext> {
  const tokenResponse = await getCopilotToken();
  const device = await getDeviceInfo();
  return {
    apiBase: getCopilotApiBaseUrl(tokenResponse),
    headers: buildHeaders(tokenResponse.token, device),
  };
}

export function forwardUpstreamIds(upstream: globalThis.Response, res: Response): void {
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) {
    res.setHeader('x-request-id', requestId);
  }

  const githubRequestId = upstream.headers.get('x-github-request-id');
  if (githubRequestId) {
    res.setHeader('x-github-request-id', githubRequestId);
  }
}

export function forwardUpstreamHeaders(upstream: globalThis.Response, res: Response): void {
  forwardUpstreamIds(upstream, res);
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
}
