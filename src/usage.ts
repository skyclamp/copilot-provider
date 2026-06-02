import { dirname, resolve } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import keys from './keys.json' with { type: 'json' };

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);
const USAGE_DIR = resolve(MODULE_DIR, '..', 'usage');

type KeysFile = { claude: string[]; openai: string[] };
const keysTyped = keys as KeysFile;

const KEY_TO_ID = new Map<string, string>();
for (const [i, key] of keysTyped.claude.entries()) {
  KEY_TO_ID.set(key, `claude-${String(i + 1).padStart(2, '0')}`);
}
for (const [i, key] of keysTyped.openai.entries()) {
  KEY_TO_ID.set(key, `openai-${String(i + 1).padStart(2, '0')}`);
}

export function resolveKeyId(key: string | null | undefined): string | null {
  if (!key) return null;
  return KEY_TO_ID.get(key) ?? null;
}

export function listKeyIds(): string[] {
  return Array.from(KEY_TO_ID.values());
}

export function pickHeaderExtras(headers: Headers, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = headers.get(name);
    if (typeof v === 'string' && v.length > 0) {
      out[name] = v;
      break;
    }
  }
  return out;
}

function currentMonth(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function usageLogPath(keyId: string, month: string = currentMonth()): string {
  return resolve(USAGE_DIR, `${keyId}-${month}.jsonl`);
}

type UsageRecord = {
  model: string | null;
  usage: Record<string, unknown>;
  extras?: Record<string, string>;
};

export async function recordUsage(keyId: string | null | undefined, { model, usage, extras }: UsageRecord): Promise<void> {
  if (!keyId) return;
  if (Bun.env.DISABLE_USAGE_LOGGING === 'true') return;
  const now = new Date();
  const path = usageLogPath(keyId, currentMonth(now));
  const entry = {
    ts: now.getTime(),
    model: model || null,
    usage: usage || {},
    ...(extras && typeof extras === 'object' ? extras : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n');
}

// -------------------- SSE streaming parser --------------------

function mergeDeep(target: Record<string, any>, src: any): Record<string, any> {
  if (!src || typeof src !== 'object') return target;
  for (const [k, v] of Object.entries(src)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (target[k] == null || typeof target[k] !== 'object') target[k] = {};
      mergeDeep(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export class SSEUsageParser {
  buffer = '';
  model: string | null = null;
  usage: Record<string, any> = {};

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this._parseEvent(raw);
    }
  }

  private _parseEvent(raw: string): void {
    let eventType = '';
    let dataStr = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trimStart();
    }
    if (!dataStr || dataStr === '[DONE]') return;
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }

    if (eventType === 'message_start' && data.message) {
      if (data.message.model) this.model = data.message.model;
      if (data.message.usage) mergeDeep(this.usage, data.message.usage);
      return;
    }
    if (eventType === 'message_delta' && data.usage) {
      mergeDeep(this.usage, data.usage);
      return;
    }

    const responseObj =
      eventType === 'response.completed' || data?.type === 'response.completed' ||
      eventType === 'response.created' || data?.type === 'response.created'
        ? data.response
        : null;
    if (responseObj) {
      if (responseObj.model) this.model = responseObj.model;
      if (responseObj.usage) mergeDeep(this.usage, responseObj.usage);
      return;
    }

    if (data.object === 'chat.completion.chunk' || data.object === 'chat.completion') {
      if (data.model) this.model = data.model;
      if (data.usage) mergeDeep(this.usage, data.usage);
    }
  }

  result(): { model: string | null; usage: Record<string, any> } {
    return { model: this.model, usage: this.usage };
  }
}

function extractFromJsonBody(jsonText: string): { model: string | null; usage: Record<string, any> } {
  let json: any;
  try {
    json = JSON.parse(jsonText);
  } catch {
    return { model: null, usage: {} };
  }
  if (!json || typeof json !== 'object') return { model: null, usage: {} };
  return { model: json.model || null, usage: json.usage || {} };
}

// -------------------- Tee + track --------------------

type PipeOptions = {
  endpoint: string;
  keyId: string;
  stream: boolean;
  requestModel: string | null;
  extras?: Record<string, string>;
};

export function pipeAndExtractUsage(
  upstream: Response,
  respHeaders: Headers,
  opts: PipeOptions,
): Response {
  const status = upstream.status;
  const contentType = upstream.headers.get('content-type') || '';
  const isSSE = contentType.includes('text/event-stream') || opts.stream;

  if (!upstream.body) {
    return new Response(null, { status, headers: respHeaders });
  }

  if (Bun.env.DISABLE_USAGE_LOGGING === 'true') {
    return new Response(upstream.body, { status, headers: respHeaders });
  }

  const [clientStream, parseStream] = upstream.body.tee();

  (async () => {
    const parser = isSSE ? new SSEUsageParser() : null;
    let jsonBuffer = '';
    const decoder = new TextDecoder();
    const reader = parseStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (parser) parser.feed(text);
        else jsonBuffer += text;
      }
    } catch (err) {
      console.error(`[usage] stream error for ${opts.endpoint}:`, err);
      return;
    }

    const extracted = parser ? parser.result() : extractFromJsonBody(jsonBuffer);
    const model = opts.requestModel || extracted.model || null;
    const usage = extracted.usage || {};

    try {
      await recordUsage(opts.keyId, { model, usage, extras: opts.extras });
    } catch (err) {
      console.error('[usage] failed to record:', err);
    }
  })();

  return new Response(clientStream, { status, headers: respHeaders });
}
