import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);
const LOG_DIR = resolve(MODULE_DIR, '..', 'logs');
const REDACTED = '[REDACTED]';
const pendingWrites = new Map<string, Promise<void>>();
let logDirReady: Promise<void> | null = null;

type ProductPrefix = 'cc' | 'cx' | 'oc' | 'gb';

type SessionIdentity = {
  prefix: ProductPrefix;
  sessionId: string;
};

function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    result[name] = /authorization|cookie|token|api[-_]?key|secret/i.test(name)
      ? REDACTED
      : value;
  }
  return result;
}

function sessionIdentity(req: Request): SessionIdentity | null {
  const knownHeaders: Array<[string, ProductPrefix]> = [
    ['x-claude-code-session-id', 'cc'],
    ['x-grok-session-id', 'gb'],
    ['x-opencode-session', 'oc'],
    ['x-session-affinity', 'oc'],
    ['session-id', 'cx'],
  ];

  for (const [name, prefix] of knownHeaders) {
    const sessionId = req.headers.get(name)?.trim();
    if (sessionId) return { prefix, sessionId };
  }

  const sessionId = req.headers.get('x-session-id')?.trim();
  if (!sessionId) return null;

  const userAgent = req.headers.get('user-agent')?.toLowerCase() ?? '';
  if (userAgent.includes('opencode')) return { prefix: 'oc', sessionId };
  if (userAgent.includes('grok-shell') || userAgent.includes('xai-grok-build')) {
    return { prefix: 'gb', sessionId };
  }
  if (userAgent.includes('claude')) return { prefix: 'cc', sessionId };
  return { prefix: 'cx', sessionId };
}

function safeSessionId(sessionId: string): string {
  return sessionId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160) || 'unknown';
}

function ensureLogDir(): Promise<void> {
  if (!logDirReady) {
    logDirReady = mkdir(LOG_DIR, { recursive: true })
      .then(() => {})
      .catch(error => {
        logDirReady = null;
        throw error;
      });
  }
  return logDirReady;
}

function appendRecord(path: string, record: Record<string, unknown>): Promise<void> {
  const previous = pendingWrites.get(path) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await ensureLogDir();
      await appendFile(path, `${JSON.stringify(record)}\n`);
    })
    .catch(error => {
      console.error(`[session-log] failed to append ${JSON.stringify(path)}:`, error);
    });
  pendingWrites.set(path, next);
  void next.finally(() => {
    if (pendingWrites.get(path) === next) pendingWrites.delete(path);
  });
  return next;
}

export type SessionEventLogger = {
  request(method: string, path: string): void;
  response(response: Response): Promise<Response>;
};

export function createSessionEventLogger(req: Request): SessionEventLogger | null {
  const identity = sessionIdentity(req);
  if (!identity) return null;

  const logPath = resolve(LOG_DIR, `${identity.prefix}-${safeSessionId(identity.sessionId)}.jsonl`);
  const requestId = crypto.randomUUID();
  const includeChunkContent = Bun.env.LOG_CHUNK_CONTENT === 'true';

  function write(record: Record<string, unknown>): Promise<void> {
    return appendRecord(logPath, { ts: Date.now(), requestId, ...record });
  }

  async function response(upstream: Response): Promise<Response> {
    void write({
      event: 'response_start',
      status: upstream.status,
      headers: headerRecord(upstream.headers),
    });

    if (!upstream.body) {
      await write({ event: 'response_end', complete: true });
      return upstream;
    }

    const reader = upstream.body.getReader();
    const decoder = includeChunkContent ? new TextDecoder() : null;
    let ended = false;

    async function end(complete: boolean): Promise<void> {
      if (ended) return;
      ended = true;
      await write({ event: 'response_end', complete });
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            await end(true);
            controller.close();
            return;
          }

          const chunkRecord: Record<string, unknown> = { event: 'chunk' };
          if (decoder) chunkRecord.content = decoder.decode(value, { stream: true });
          void write(chunkRecord);
          controller.enqueue(value);
        } catch (error) {
          await end(false);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await end(false);
        }
      },
    });

    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }

  return {
    request(method: string, path: string): void {
      void write({
        event: 'request',
        method,
        path,
        headers: headerRecord(req.headers),
      });
    },
    response,
  };
}
