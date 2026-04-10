import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { getCopilotToken, getCopilotApiBaseUrl } from './copilot-token';
import { MODEL_ALIASES } from './constants';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const DEVICE_FILE = resolve(PROJECT_ROOT, '.device');

interface DeviceInfo {
  vscodeSessionId: string;
  vscodeMachineId: string;
  editorDeviceId: string;
}

let deviceInfo: DeviceInfo | null = null;

async function getDeviceInfo(): Promise<DeviceInfo> {
  if (deviceInfo) return deviceInfo;
  const file = Bun.file(DEVICE_FILE);
  if (!(await file.exists())) {
    throw new Error(`.device not found. Run: bun run scripts/setup-device.ts`);
  }
  deviceInfo = await file.json();
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

function mapModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

export async function proxyMessages(req: Request, res: Response): Promise<void> {
  try {
    const tokenResponse = await getCopilotToken();
    const device = await getDeviceInfo();
    const apiBase = getCopilotApiBaseUrl(tokenResponse);
    const headers = buildHeaders(tokenResponse.token, device);

    const body = { ...req.body };
    if (body.model) {
      body.model = mapModel(body.model);
    }

    const url = `${apiBase}/v1/messages`;
    const effort = body.output_config?.effort ?? 'high';
    const thinkingType = body.thinking?.type ?? 'none';
    console.log(`[proxy] ${body.model} stream=${body.stream ?? false} effort:${effort} thinking:${thinkingType}`);

    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // Forward status + common headers
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const requestId = upstream.headers.get('x-request-id');
    if (requestId) res.setHeader('x-request-id', requestId);

    // Non-200: read body, log, then forward
    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`[proxy] upstream ${upstream.status}: ${errorBody}`);
      res.send(errorBody);
      return;
    }

    // 200: pipe body (works for both streaming SSE and regular JSON)
    if (upstream.body) {
      res.flushHeaders();
      const readable = Readable.fromWeb(upstream.body as any);
      readable.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error('[proxy] Error:', error);
    if (!res.headersSent) {
      res.status(502).json({
        type: 'error',
        error: { type: 'proxy_error', message: String(error) },
      });
    }
  }
}
