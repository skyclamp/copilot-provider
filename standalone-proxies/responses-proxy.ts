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
    return new Response(upstream.body, {
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
