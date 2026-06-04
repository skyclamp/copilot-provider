const DEFAULT_MCP_URL = 'https://api.githubcopilot.com/mcp/readonly';
const MCP_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_TIMEOUT_MS = 60_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MCP_USER_AGENT = 'copilot-provider';

export type WebSearchInput = {
  query: string;
};

export type WebSearchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type WebSearchSuccess = {
  ok: true;
  text: string;
  structuredContent: unknown | null;
  raw: Record<string, unknown>;
};

export type WebSearchFailure = {
  ok: false;
  error: string;
  status?: number;
};

export type WebSearchResult = WebSearchSuccess | WebSearchFailure;

type Session = {
  sessionId: string;
  protocolVersion: string;
};

type CachedSession = {
  session: Session;
  url: string;
  token: string;
  expiresAt: number;
};

type JsonRpcResponse = {
  jsonrpc?: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

class McpError extends Error {
  status?: number;
  recoverable: boolean;
  constructor(message: string, status?: number, recoverable = false) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.recoverable = recoverable;
  }
}

let cachedSession: CachedSession | null = null;
let initInFlight: Promise<Session> | null = null;

function readToken(): string {
  const token = Bun.env.GITHUB_COPILOT_TOKEN;
  if (!token) {
    throw new Error('GITHUB_COPILOT_TOKEN not set in .env (required for web_search MCP calls).');
  }
  return token;
}

function getMcpUrl(): string {
  return Bun.env.GITHUB_COPILOT_MCP_URL || DEFAULT_MCP_URL;
}

function buildHeaders(token: string, session?: Session): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-MCP-Host': 'copilot-cli',
    'X-MCP-Tools': 'web_search',
    'User-Agent': MCP_USER_AGENT,
  };
  if (session) {
    if (session.sessionId) headers['mcp-session-id'] = session.sessionId;
    if (session.protocolVersion) headers['mcp-protocol-version'] = session.protocolVersion;
  }
  return headers;
}

function makeSignal(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  return AbortSignal.any([timeout, external]);
}

function parseSseEvent(raw: string): JsonRpcResponse | null {
  let dataStr = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) {
      dataStr += line.slice(5).trimStart();
    }
  }
  if (!dataStr || dataStr === '[DONE]') return null;
  try {
    return JSON.parse(dataStr) as JsonRpcResponse;
  } catch {
    return null;
  }
}

async function readResponseForId(response: Response, expectId: number | string): Promise<JsonRpcResponse | null> {
  if (!response.body) return null;
  const ct = (response.headers.get('content-type') || '').toLowerCase();

  if (ct.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const msg = parseSseEvent(raw);
          if (msg && msg.id === expectId) {
            try { await reader.cancel(); } catch {}
            return msg;
          }
        }
      }
      if (buffer.trim()) {
        const msg = parseSseEvent(buffer);
        if (msg && msg.id === expectId) return msg;
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    return null;
  }

  const text = await response.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && item.id === expectId) return item as JsonRpcResponse;
      }
      return null;
    }
    return parsed as JsonRpcResponse;
  } catch {
    return null;
  }
}

async function drainBody(response: Response): Promise<void> {
  if (!response.body) return;
  try { await response.body.cancel(); } catch {}
}

async function initializeSession(token: string, url: string, signal: AbortSignal): Promise<Session> {
  const initBody = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'copilot-provider',
        version: '0.1.0',
      },
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(initBody),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    await drainBody(response);
    throw new McpError(
      `MCP initialize failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`,
      response.status,
    );
  }

  const sessionId = response.headers.get('mcp-session-id') || '';
  const msg = await readResponseForId(response, 0);
  if (!msg || !msg.result) {
    throw new McpError('MCP initialize returned no result', response.status);
  }
  const result = msg.result as { protocolVersion?: string };
  const protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION;

  const session: Session = { sessionId, protocolVersion };

  const notifBody = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  };
  const notifResponse = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, session),
    body: JSON.stringify(notifBody),
    signal,
  });
  await drainBody(notifResponse);
  if (!notifResponse.ok && notifResponse.status !== 202) {
    throw new McpError(
      `MCP initialized notification failed: ${notifResponse.status} ${notifResponse.statusText}`,
      notifResponse.status,
    );
  }

  return session;
}

async function ensureSession(token: string, url: string, signal: AbortSignal): Promise<Session> {
  const now = Date.now();
  if (cachedSession && cachedSession.url === url && cachedSession.token === token && cachedSession.expiresAt > now) {
    return cachedSession.session;
  }
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    const session = await initializeSession(token, url, signal);
    cachedSession = { session, url, token, expiresAt: Date.now() + SESSION_TTL_MS };
    return session;
  })();

  try {
    return await initInFlight;
  } finally {
    initInFlight = null;
  }
}

function invalidateSession(): void {
  cachedSession = null;
}

async function callTool(
  token: string,
  url: string,
  session: Session,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  requestId: number,
): Promise<unknown> {
  const body = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: { name, arguments: args },
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, session),
    body: JSON.stringify(body),
    signal,
  });

  if (response.status === 404) {
    await drainBody(response);
    throw new McpError(`MCP session not found (404)`, 404, true);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new McpError(
      `MCP tools/call failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`,
      response.status,
    );
  }

  const msg = await readResponseForId(response, requestId);
  if (!msg) {
    throw new McpError('MCP tools/call returned no message', response.status);
  }
  if (msg.error) {
    throw new McpError(`MCP error ${msg.error.code}: ${msg.error.message}`, response.status);
  }
  return msg.result;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).type === 'text' &&
      typeof (item as Record<string, unknown>).text === 'string'
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('\n');
}

let requestCounter = 1;

export async function webSearch(input: WebSearchInput, options?: WebSearchOptions): Promise<WebSearchResult> {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (!query) return { ok: false, error: 'query is required' };

  let token: string;
  try {
    token = readToken();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const url = getMcpUrl();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = makeSignal(options?.signal, timeoutMs);

  const args = { query };
  const callOnce = async (): Promise<unknown> => {
    const session = await ensureSession(token, url, signal);
    return callTool(token, url, session, 'web_search', args, signal, ++requestCounter);
  };

  let result: unknown;
  try {
    result = await callOnce();
  } catch (err) {
    if (err instanceof McpError && err.recoverable) {
      invalidateSession();
      try {
        result = await callOnce();
      } catch (retryErr) {
        const e = retryErr instanceof McpError ? retryErr : null;
        return {
          ok: false,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          ...(e?.status !== undefined ? { status: e.status } : {}),
        };
      }
    } else if (err instanceof McpError) {
      return {
        ok: false,
        error: err.message,
        ...(err.status !== undefined ? { status: err.status } : {}),
      };
    } else {
      return { ok: false, error: `web_search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'MCP returned no result' };
  }
  const r = result as Record<string, unknown>;
  if (r.isError === true) {
    return { ok: false, error: extractText(r.content) || 'MCP tool returned an error' };
  }
  return {
    ok: true,
    text: extractText(r.content),
    structuredContent: r.structuredContent ?? null,
    raw: r,
  };
}
