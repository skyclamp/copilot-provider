import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const USAGE_DIR = resolve(MODULE_DIR, '..', 'usage');
const keys = JSON.parse(readFileSync(resolve(MODULE_DIR, 'keys.json'), 'utf-8'));

// Map full key -> identifier (e.g. "claude-01", "openai-07")
const KEY_TO_ID = new Map();
for (const [i, key] of keys.claude.entries()) {
  KEY_TO_ID.set(key, `claude-${String(i + 1).padStart(2, '0')}`);
}
for (const [i, key] of keys.openai.entries()) {
  KEY_TO_ID.set(key, `openai-${String(i + 1).padStart(2, '0')}`);
}

export function resolveKeyId(key) {
  if (!key) return null;
  return KEY_TO_ID.get(key) ?? null;
}

export function listKeyIds() {
  return Array.from(KEY_TO_ID.values());
}

// Picks the first present header value from the given list and returns
// an object like { [headerName]: value }. Useful for preserving the
// provenance of session identifiers in usage logs.
export function pickHeaderExtras(headers, names) {
  const out = {};
  if (!headers) return out;
  for (const name of names) {
    const v = headers[name];
    if (typeof v === 'string' && v.length > 0) {
      out[name] = v;
      break;
    }
  }
  return out;
}

function currentMonth(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function usageLogPath(keyId, month = currentMonth()) {
  return resolve(USAGE_DIR, `${keyId}-${month}.jsonl`);
}

// Appends one JSON object per line. A single fs.appendFile call issues a POSIX
// append, which is atomic for small writes, so no explicit lock is needed.
export async function recordUsage(keyId, { model, usage, extras }) {
  if (!keyId) return;
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
//
// Providers emit cumulative usage values across multiple events, so we merge
// subsequent fields on top of earlier ones. The raw usage shape is preserved
// so downstream consumers get the full provider payload.

function mergeDeep(target, src) {
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
  constructor() {
    this.buffer = '';
    this.model = null;
    this.usage = {};
  }

  feed(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this._parseEvent(raw);
    }
  }

  _parseEvent(raw) {
    let eventType = '';
    let dataStr = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trimStart();
    }
    if (!dataStr || dataStr === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }

    // Anthropic messages
    if (eventType === 'message_start' && data.message) {
      if (data.message.model) this.model = data.message.model;
      if (data.message.usage) mergeDeep(this.usage, data.message.usage);
      return;
    }
    if (eventType === 'message_delta' && data.usage) {
      mergeDeep(this.usage, data.usage);
      return;
    }

    // OpenAI /v1/responses — response.completed carries the final usage
    const responseObj =
      (eventType === 'response.completed' || data?.type === 'response.completed' ||
       eventType === 'response.created' || data?.type === 'response.created')
        ? data.response
        : null;
    if (responseObj) {
      if (responseObj.model) this.model = responseObj.model;
      if (responseObj.usage) mergeDeep(this.usage, responseObj.usage);
    }
  }

  result() {
    return { model: this.model, usage: this.usage };
  }
}

function extractFromJsonBody(jsonText) {
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch {
    return { model: null, usage: {} };
  }
  if (!json || typeof json !== 'object') return { model: null, usage: {} };
  return { model: json.model || null, usage: json.usage || {} };
}

// -------------------- Tee + track --------------------

export async function pipeAndExtractUsage(upstream, res, { endpoint, keyId, stream, requestModel, extras }) {
  res.flushHeaders();
  const contentType = upstream.headers.get('content-type') || '';
  const isSSE = contentType.includes('text/event-stream') || stream;

  const parser = isSSE ? new SSEUsageParser() : null;
  let jsonBuffer = isSSE ? null : '';

  const readable = Readable.fromWeb(upstream.body);
  const decoder = new TextDecoder();

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      readable.on('data', (chunk) => {
        res.write(chunk);
        const text = decoder.decode(chunk, { stream: true });
        if (parser) parser.feed(text);
        else jsonBuffer += text;
      });
      readable.on('end', () => {
        res.end();
        resolvePromise();
      });
      readable.on('error', (err) => {
        res.destroy(err);
        rejectPromise(err);
      });
    });
  } catch (err) {
    console.error(`[usage] stream error for ${endpoint}:`, err);
    return;
  }

  const extracted = parser ? parser.result() : extractFromJsonBody(jsonBuffer);
  // Model recorded is the one the client asked for (from the request body),
  // which is stable even when the upstream omits it in its response.
  const model = requestModel || extracted.model || null;
  const usage = extracted.usage || {};

  try {
    await recordUsage(keyId, { model, usage, extras });
  } catch (err) {
    console.error('[usage] failed to record:', err);
  }
}
