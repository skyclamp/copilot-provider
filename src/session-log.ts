import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requestSessionIdentity } from './session.ts';

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);
const LOG_DIR = resolve(MODULE_DIR, '..', 'logs');
const REDACTED = '[REDACTED]';
const FLUSH_INTERVAL_MS = 20;
const MAX_BUFFER_CHARS = 64 * 1024;

type Appender = {
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  tail: Promise<void>;
};

const appenders = new Map<string, Appender>();
let logDirReady: Promise<void> | null = null;

function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    result[name] = /authorization|cookie|token|api[-_]?key|secret/i.test(name)
      ? REDACTED
      : value;
  }
  return result;
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

function scheduleFlush(path: string, appender: Appender): void {
  if (appender.timer) return;
  appender.timer = setTimeout(() => {
    appender.timer = null;
    void flushAppender(path, appender);
  }, FLUSH_INTERVAL_MS);
}

function flushAppender(path: string, appender: Appender): Promise<void> {
  if (appender.timer) {
    clearTimeout(appender.timer);
    appender.timer = null;
  }
  if (!appender.buffer) return appender.tail;

  const content = appender.buffer;
  appender.buffer = '';
  const next = appender.tail
    .then(async () => {
      await ensureLogDir();
      await appendFile(path, content);
    })
    .catch(error => {
      console.error(`[session-log] failed to append ${JSON.stringify(path)}:`, error);
    });
  appender.tail = next;
  void next.finally(() => {
    if (appender.tail !== next) return;
    if (appender.buffer) scheduleFlush(path, appender);
    else if (!appender.timer) appenders.delete(path);
  });
  return next;
}

function appendRecord(path: string, record: Record<string, unknown>): void {
  let appender = appenders.get(path);
  if (!appender) {
    appender = { buffer: '', timer: null, tail: Promise.resolve() };
    appenders.set(path, appender);
  }
  appender.buffer += `${JSON.stringify(record)}\n`;
  if (appender.buffer.length >= MAX_BUFFER_CHARS) void flushAppender(path, appender);
  else scheduleFlush(path, appender);
}

export async function flushSessionLogs(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [path, appender] of appenders) {
    pending.push(flushAppender(path, appender));
  }
  await Promise.all(pending);
}

export type SessionEventLogger = {
  request(method: string, path: string): void;
  response(response: Response): Promise<Response>;
};

export function createSessionEventLogger(req: Request): SessionEventLogger | null {
  const identity = requestSessionIdentity(req);
  if (!identity) return null;

  const logPath = resolve(LOG_DIR, `${identity.prefix}-${safeSessionId(identity.sessionId)}.jsonl`);
  const requestId = crypto.randomUUID();
  const includeChunkContent = Bun.env.LOG_CHUNK_CONTENT === 'true';

  function write(record: Record<string, unknown>): void {
    appendRecord(logPath, { ts: Date.now(), requestId, ...record });
  }

  async function response(upstream: Response): Promise<Response> {
    write({
      event: 'response_start',
      status: upstream.status,
      headers: headerRecord(upstream.headers),
    });

    if (!upstream.body) {
      write({ event: 'response_end', complete: true });
      return upstream;
    }

    const reader = upstream.body.getReader();
    const decoder = includeChunkContent ? new TextDecoder() : null;
    let ended = false;

    function end(complete: boolean): void {
      if (ended) return;
      ended = true;
      write({ event: 'response_end', complete });
    }

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            end(true);
            controller.close();
            return;
          }

          const chunkRecord: Record<string, unknown> = { event: 'chunk' };
          if (decoder) chunkRecord.content = decoder.decode(value, { stream: true });
          write(chunkRecord);
          controller.enqueue(value);
        } catch (error) {
          end(false);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          end(false);
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
      write({
        event: 'request',
        method,
        path,
        headers: headerRecord(req.headers),
      });
    },
    response,
  };
}
