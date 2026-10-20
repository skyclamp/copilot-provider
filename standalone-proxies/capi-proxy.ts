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

// A line plus its original terminator ('' for an unterminated tail at EOF).
// `continuation` marks an LF that completes a CR already emitted as a line.
type Line = { text: string; eol: string; continuation?: true };

type ServerSentEvent = { event: string | null; data: string; raw: string[] };

const LIFECYCLE_EVENTS = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
]);

// Port of openai-node's LineDecoder (src/internal/decoders/line.ts) over text,
// keeping each terminator so untouched events are forwarded byte-for-byte.
// Like the SDK, a trailing CR completes its line immediately and a following
// LF in the next chunk is consumed as its continuation.
class LineDecoder {
  #buffer = '';
  #skipLeadingLF = false;

  decode(text: string): Line[] {
    if (!text) return [];
    const lines: Line[] = [];
    if (this.#skipLeadingLF) {
      this.#skipLeadingLF = false;
      if (text.startsWith('\n')) {
        lines.push({ text: '', eol: '\n', continuation: true });
        text = text.slice(1);
      }
    }
    const endings = /\r\n|[\r\n]/g;
    const buffer = this.#buffer + text;
    let start = 0;
    for (let match; (match = endings.exec(buffer));) {
      lines.push({ text: buffer.slice(start, match.index), eol: match[0] });
      start = endings.lastIndex;
    }
    this.#buffer = buffer.slice(start);
    this.#skipLeadingLF = buffer.endsWith('\r') && start === buffer.length;
    return lines;
  }

  flush(): Line[] {
    this.#skipLeadingLF = false;
    if (!this.#buffer) return [];
    const line = { text: this.#buffer, eol: '' };
    this.#buffer = '';
    return [line];
  }
}

// Port of openai-node's SSEDecoder (src/core/streaming.ts). Unlike the SDK it
// also returns blocks without fields (comments, stray blank lines) so the
// proxy can forward them unchanged.
class SSEDecoder {
  #event: string | null = null;
  #data: string[] = [];
  #raw: string[] = [];

  decode(line: Line): { sse: ServerSentEvent | null; raw: string[] } | null {
    this.#raw.push(line.text + line.eol);
    if (line.text) {
      if (!line.text.startsWith(':')) {
        const colon = line.text.indexOf(':');
        const field = colon === -1 ? line.text : line.text.slice(0, colon);
        let value = colon === -1 ? '' : line.text.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.#event = value;
        else if (field === 'data') this.#data.push(value);
      }
      return null;
    }

    const sse = this.#event !== null || this.#data.length
      ? { event: this.#event, data: this.#data.join('\n'), raw: this.#raw }
      : null;
    const raw = this.#raw;
    this.#event = null;
    this.#data = [];
    this.#raw = [];
    return { sse, raw };
  }

  // Appends the LF of a CRLF split across chunks to the pending raw lines;
  // returns false when no event is pending and the LF should pass through.
  continueLine(): boolean {
    if (!this.#raw.length) return false;
    this.#raw[this.#raw.length - 1] += '\n';
    return true;
  }

  // Servers may omit the blank line ending the last event; like the SDK,
  // dispatch it at EOF, but without inventing a terminator.
  flush(): { sse: ServerSentEvent | null; raw: string[] } | null {
    return this.#raw.length ? this.decode({ text: '', eol: '' }) : null;
  }
}

function stabilizeResponseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const itemIds = new Map<number, string>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const lineDecoder = new LineDecoder();
  const sseDecoder = new SSEDecoder();

  function normalize(index: number | undefined, id: string | undefined): string | undefined {
    if (index === undefined || id === undefined) return id;
    if (!itemIds.has(index)) itemIds.set(index, id);
    return itemIds.get(index)!;
  }

  function rewrite(sse: ServerSentEvent | null, raw: string[]): string {
    const original = raw.join('');
    if (!sse || !sse.data || sse.data === '[DONE]') return original;
    let event: ResponseEvent;
    try {
      event = JSON.parse(sse.data);
    } catch {
      return original;
    }
    if (typeof event?.type !== 'string' || !event.type.startsWith('response.')) return original;
    let changed = false;

    function normalizeItem(index: number | undefined, item: OutputItem) {
      const id = normalize(index, item.id);
      if (id !== item.id) {
        item.id = id;
        changed = true;
      }
    }

    // Same identity rules the SDK accumulator enforces: item-scoped events
    // must reference output[output_index].id, and lifecycle snapshots must
    // repeat the IDs of the items streamed at those indexes.
    if (LIFECYCLE_EVENTS.has(event.type)) {
      event.response?.output?.forEach((item, index) => normalizeItem(index, item));
    } else {
      if (event.item) normalizeItem(event.output_index, event.item);
      const id = normalize(event.output_index, event.item_id);
      if (id !== event.item_id) {
        event.item_id = id;
        changed = true;
      }
    }
    if (!changed) return original;

    // Keep SSE metadata and comments; replace the data field only once.
    let emittedData = false;
    return raw.map(line => {
      const text = line.replace(/(?:\r\n|\r|\n)$/, '');
      if (text !== 'data' && !text.startsWith('data:')) return line;
      if (emittedData) return '';
      emittedData = true;
      return `data: ${JSON.stringify(event)}${line.slice(text.length)}`;
    }).join('');
  }

  function feed(lines: Line[], controller: TransformStreamDefaultController<Uint8Array>) {
    for (const line of lines) {
      if (line.continuation) {
        if (!sseDecoder.continueLine()) controller.enqueue(encoder.encode(line.eol));
        continue;
      }
      const block = sseDecoder.decode(line);
      if (block) controller.enqueue(encoder.encode(rewrite(block.sse, block.raw)));
    }
  }

  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      feed(lineDecoder.decode(decoder.decode(chunk, { stream: true })), controller);
    },
    flush(controller) {
      feed(lineDecoder.decode(decoder.decode()), controller);
      feed(lineDecoder.flush(), controller);
      const pending = sseDecoder.flush();
      if (pending) controller.enqueue(encoder.encode(rewrite(pending.sse, pending.raw)));
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
      console.error(`Upstream ${upstream.status}: ${errorBody}`);
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
    return proxyError(error);
  }
}

async function proxyMessages(req: Request): Promise<Response> {
  try {
    const token = await getCopilotToken();
    const apiBase = token.endpoints?.api?.replace(/\/+$/, '') || 'https://api.githubcopilot.com';
    const headers = copilotHeaders(req, token.token);
    const anthropicBeta = req.headers.get('anthropic-beta');
    if (anthropicBeta) headers['anthropic-beta'] = anthropicBeta;
    const upstream = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: req.body,
    });
    const respHeaders = responseHeaders(upstream);
    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.error(`Upstream ${upstream.status}: ${errorBody}`);
      return new Response(errorBody, { status: upstream.status, headers: respHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (error) {
    return proxyError(error);
  }
}

function proxyError(error: unknown): Response {
  console.error('proxy error:', error);
  return Response.json(
    { type: 'error', error: { type: 'proxy_error', message: String(error) } },
    { status: 502 },
  );
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
    if (req.method === 'POST' && pathname === '/v1/messages') {
      return proxyMessages(req);
    }
    return new Response('null', {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
