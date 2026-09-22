type CopilotToken = {
  token: string;
  expires_at: number;
  endpoints?: { api?: string };
};

type CliOptions = {
  githubToken: string;
  gheHost: string | null;
};

const VSCODE_MACHINE_ID = crypto.randomUUID();
const EDITOR_DEVICE_ID = crypto.randomUUID();
const GITHUB_API_VERSION = '2026-06-01';
const VSCODE_VERSION = '1.134.0';
const COPILOT_CHAT_VERSION = '0.63.0';

let cachedToken: CopilotToken | null = null;
let refreshInFlight: Promise<CopilotToken> | null = null;

function readCliOptions(): CliOptions {
  let githubToken: string | null = null;
  let gheHost: string | null = null;
  const args = Bun.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--github-token') {
      if (!value) throw new Error('--github-token requires a value');
      githubToken = value;
      index += 1;
    } else if (argument === '--ghe-host') {
      if (!value) throw new Error('--ghe-host requires a value');
      gheHost = value.replace(/^https?:\/\//, '').replace(/\/+$/, '').trim() || null;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!githubToken) throw new Error('--github-token is required');
  return { githubToken, gheHost };
}

const options = readCliOptions();

function githubApiBaseUrl(): string {
  return options.gheHost ? `https://api.${options.gheHost}` : 'https://api.github.com';
}

function isTokenValid(token: CopilotToken | null): token is CopilotToken {
  return Boolean(token?.token && token.expires_at > Math.floor(Date.now() / 1000) + 60);
}

async function exchangeCopilotToken(): Promise<CopilotToken> {
  const response = await fetch(`${githubApiBaseUrl()}/copilot_internal/v2/token`, {
    headers: {
      Authorization: `token ${options.githubToken}`,
      'X-GitHub-Api-Version': '2025-04-01',
      'Editor-Device-Id': EDITOR_DEVICE_ID,
    },
  });
  if (!response.ok) {
    throw new Error(`Copilot token exchange failed with ${response.status}`);
  }

  const token = await response.json() as CopilotToken;
  if (!token.token || !token.expires_at) {
    throw new Error('Copilot token exchange returned an invalid response');
  }
  return token;
}

async function getCopilotToken(): Promise<CopilotToken> {
  if (isTokenValid(cachedToken)) return cachedToken;
  if (refreshInFlight) return refreshInFlight;

  const refresh = exchangeCopilotToken().then(token => {
    cachedToken = token;
    return token;
  });
  refreshInFlight = refresh;
  try {
    return await refresh;
  } finally {
    if (refreshInFlight === refresh) refreshInFlight = null;
  }
}

function sessionId(req: Request): string | null {
  for (const header of [
    'x-claude-code-session-id',
    'x-grok-session-id',
    'x-opencode-session',
    'x-session-affinity',
    'session-id',
    'x-session-id',
  ]) {
    const value = req.headers.get(header)?.trim();
    if (value) return value;
  }
  return null;
}

function copilotHeaders(req: Request, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'VScode-MachineId': VSCODE_MACHINE_ID,
    'Editor-Device-Id': EDITOR_DEVICE_ID,
    'X-Request-Id': crypto.randomUUID(),
    'Editor-Plugin-Version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
    'Editor-Version': `vscode/${VSCODE_VERSION}`,
  };
  const accept = req.headers.get('accept');
  if (accept) headers.Accept = accept;
  const clientSessionId = sessionId(req);
  if (clientSessionId) headers['VScode-SessionId'] = clientSessionId;
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) headers.set('x-request-id', requestId);
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

// Kept inline from src/responses-stream.ts so this proxy remains a single file.
type OutputItem = { id?: string };
type ResponseEvent = {
  type: string;
  output_index?: number;
  item_id?: string;
  item?: OutputItem;
  response?: { output?: OutputItem[] };
};

function stabilizeResponseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const itemIds = new Map<number, string>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineParts: string[] = [];
  let eventLines: string[] = [];
  let data: string[] = [];
  let pendingCR = false;

  function normalize(index: number | undefined, id: string | undefined): string | undefined {
    if (index === undefined || id === undefined) return id;
    if (!itemIds.has(index)) itemIds.set(index, id);
    return itemIds.get(index)!;
  }

  function rewriteEvent(): string {
    const raw = eventLines.join('');
    const payload = data.join('\n');
    if (!payload || payload === '[DONE]') return raw;
    const event: ResponseEvent = JSON.parse(payload);
    let changed = false;

    function normalizeItem(index: number | undefined, item: OutputItem) {
      const id = normalize(index, item.id);
      if (id !== item.id) {
        item.id = id;
        changed = true;
      }
    }

    if (event.type.startsWith('response.')) {
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        if (event.item) normalizeItem(event.output_index, event.item);
      }
      const id = normalize(event.output_index, event.item_id);
      if (id !== event.item_id) {
        event.item_id = id;
        changed = true;
      }
    }
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
      event.response?.output?.forEach((item, index) => normalizeItem(index, item));
    }
    if (!changed) return raw;

    // Keep SSE metadata and comments; replace the data field only once.
    let emittedData = false;
    return eventLines.map(line => {
      if (!line.startsWith('data:') && !/^data(?:\r\n|\r|\n)$/.test(line)) return line;
      if (emittedData) return '';
      emittedData = true;
      const newline = line.endsWith('\r\n') ? '\r\n' : line.slice(-1);
      return `data: ${JSON.stringify(event)}${newline}`;
    }).join('');
  }

  function finishLine(newline: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const line = lineParts.join('');
    lineParts = [];
    eventLines.push(line + newline);
    if (!line) {
      controller.enqueue(encoder.encode(rewriteEvent()));
      eventLines = [];
      data = [];
    } else if (line === 'data' || line.startsWith('data:')) {
      const value = line.slice(5);
      data.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }

  // Adapted from openai-python's _SSELineDecoder / SSEDecoder: handle
  // CR, LF and CRLF across chunks, then join data lines at an empty line.
  function feed(text: string, controller: TransformStreamDefaultController<Uint8Array>) {
    if (!text) return;
    let start = 0;
    if (pendingCR) {
      const hasLF = text.startsWith('\n');
      finishLine(hasLF ? '\r\n' : '\r', controller);
      start = hasLF ? 1 : 0;
      pendingCR = false;
    }
    const endings = /\r\n|[\r\n]/g;
    endings.lastIndex = start;
    for (let match; (match = endings.exec(text));) {
      lineParts.push(text.slice(start, match.index));
      start = endings.lastIndex;
      if (match[0] === '\r' && start === text.length) {
        pendingCR = true;
      } else {
        finishLine(match[0], controller);
      }
    }
    if (start < text.length) lineParts.push(text.slice(start));
  }

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      feed(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      feed(decoder.decode(), controller);
      if (pendingCR) finishLine('\r', controller);
      // Preserve an unterminated upstream tail without inventing an SSE event.
      const tail = eventLines.join('') + lineParts.join('');
      if (tail) controller.enqueue(encoder.encode(tail));
    },
  }));
}

async function proxyResponses(req: Request): Promise<Response> {
  try {
    const token = await getCopilotToken();
    const apiBase = token.endpoints?.api?.replace(/\/+$/, '') || 'https://api.githubcopilot.com';
    const body = await req.json() as Record<string, unknown>;
    if (body.model === 'gpt-5.6-sol' && (body.service_tier === 'fast' || body.service_tier === 'priority')) {
      body.model = 'gpt-5.6-sol-fast';
      delete body.service_tier;
    }
    const upstream = await fetch(`${apiBase}/responses`, {
      method: 'POST',
      headers: copilotHeaders(req, token.token),
      body: JSON.stringify(body),
    });
    const headers = responseHeaders(upstream);
    if (upstream.status !== 200) {
      const errorBody = await upstream.text();
      console.error(`[responses-proxy] upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers });
    }
    const responseBody = upstream.body && upstream.headers.get('content-type')?.includes('text/event-stream')
      ? stabilizeResponseStream(upstream.body)
      : upstream.body;
    return new Response(responseBody, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    console.error('[standalone-responses] proxy error:', error);
    return Response.json(
      { type: 'error', error: { type: 'proxy_error', message: String(error) } },
      { status: 502 },
    );
  }
}

const server = Bun.serve({
  port: Number(Bun.env.PORT || '4141'),
  idleTimeout: 240,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === 'HEAD' && (pathname === '/' || pathname === '/api/hello')) {
      return new Response(null, { status: 200 });
    }
    if (req.method === 'POST' && pathname === '/responses') {
      return proxyResponses(req);
    }
    return new Response('null', {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log(`[responses-proxy] listening on http://localhost:${server.port}`);
