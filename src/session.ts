export type ProductPrefix = 'cc' | 'cx' | 'oc' | 'gb';

export type SessionIdentity = {
  header: string;
  prefix: ProductPrefix;
  sessionId: string;
};

const KNOWN_SESSION_HEADERS: ReadonlyArray<readonly [string, ProductPrefix]> = [
  ['x-claude-code-session-id', 'cc'],
  ['x-grok-session-id', 'gb'],
  ['x-opencode-session', 'oc'],
  ['x-session-affinity', 'oc'],
  ['session-id', 'cx'],
];

function prefixFromUserAgent(req: Request): ProductPrefix {
  const userAgent = req.headers.get('user-agent')?.toLowerCase() ?? '';
  if (userAgent.includes('opencode')) return 'oc';
  if (userAgent.includes('grok-shell') || userAgent.includes('xai-grok-build')) return 'gb';
  if (userAgent.includes('claude')) return 'cc';
  return 'cx';
}

export function requestSessionIdentity(req: Request): SessionIdentity | null {
  for (const [header, prefix] of KNOWN_SESSION_HEADERS) {
    const sessionId = req.headers.get(header)?.trim();
    if (sessionId) return { header, prefix, sessionId };
  }

  const header = 'x-session-id';
  const sessionId = req.headers.get(header)?.trim();
  if (!sessionId) return null;
  return { header, prefix: prefixFromUserAgent(req), sessionId };
}
