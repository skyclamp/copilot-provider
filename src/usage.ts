import { dirname, resolve } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import keys from './keys.json' with { type: 'json' };
import { requestSessionIdentity } from './session.ts';

const USAGE_DIR = resolve(process.env.USAGE_DIR || 'usage');

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

export function requestUsageExtras(req: Request): Record<string, string> {
  const extras: Record<string, string> = {};
  const identity = requestSessionIdentity(req);
  if (identity) extras[identity.header] = identity.sessionId;
  const userAgent = req.headers.get('user-agent');
  if (userAgent) extras['user-agent'] = userAgent;
  return extras;
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
  if (process.env.DISABLE_USAGE_LOGGING === 'true') return;
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
    if (this.buffer.startsWith('\uFEFF')) this.buffer = this.buffer.slice(1);

    let boundary = this.buffer.match(/\r\n\r\n|\n\n|\r\r/);
    while (boundary?.index != null) {
      const raw = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      this._parseEvent(raw);
      boundary = this.buffer.match(/\r\n\r\n|\n\n|\r\r/);
    }
  }

  finish(): void {
    if (this.buffer) this._parseEvent(this.buffer);
    this.buffer = '';
  }

  private _parseEvent(raw: string): void {
    let eventType = '';
    const dataLines: string[] = [];
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventType = value;
      else if (field === 'data') dataLines.push(value);
    }
    const dataStr = dataLines.join('\n');
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
  const isSSE = contentType.toLowerCase().includes('text/event-stream') || opts.stream;

  if (!upstream.body) {
    return new Response(null, { status, headers: respHeaders });
  }

  if (process.env.DISABLE_USAGE_LOGGING === 'true') {
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
      const tail = decoder.decode();
      if (parser) {
        if (tail) parser.feed(tail);
        parser.finish();
      } else {
        jsonBuffer += tail;
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
