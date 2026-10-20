import { randomUUID } from 'node:crypto';

export type ProductPrefix = 'cx' | 'gb';

export type SessionIdentity = {
  header: string;
  prefix: ProductPrefix;
  sessionId: string;
};

// grok-build subagents get their own x-grok-session-id; the conv-group id is
// shared with the root session, so it keys the upstream session like the
// process-wide VScode-SessionId does for VS Code subagents.
const KNOWN_SESSION_HEADERS: ReadonlyArray<readonly [string, ProductPrefix]> = [
  ['x-grok-conv-group-id', 'gb'],
  ['x-grok-session-id', 'gb'],
  ['session-id', 'cx'],
];

function prefixFromUserAgent(req: Request): ProductPrefix {
  const userAgent = req.headers.get('user-agent')?.toLowerCase() ?? '';
  if (userAgent.includes('grok-shell') || userAgent.includes('xai-grok-build')) return 'gb';
  return 'cx';
}

export function requestSessionIdentity(req: Request): SessionIdentity | null {
  for (const [header, prefix] of KNOWN_SESSION_HEADERS) {
    const sessionId = req.headers.get(header)?.trim();
    if (sessionId) return { header, prefix, sessionId };
  }
  return null;
}

export function requestProduct(req: Request): ProductPrefix {
  return requestSessionIdentity(req)?.prefix ?? prefixFromUserAgent(req);
}

const MAX_TRACKED_IDS = 1000;

// Returns the id remembered for `key`, creating it on first use. The map is
// kept in recency order and bounded, evicting the least recently used key.
export function rememberId(map: Map<string, string>, key: string, create: () => string): string {
  let id = map.get(key);
  if (id !== undefined) {
    map.delete(key);
  } else {
    id = create();
    if (map.size >= MAX_TRACKED_IDS) map.delete(map.keys().next().value!);
  }
  map.set(key, id);
  return id;
}

function newVscodeSessionId(): string {
  return `${randomUUID()}${Date.now()}`;
}

const processSessionId = newVscodeSessionId();
const upstreamSessions = new Map<string, string>();

export function upstreamSessionId(req: Request | undefined): string {
  const identity = req ? requestSessionIdentity(req) : null;
  if (!identity) return processSessionId;

  const key = `${identity.prefix}:${identity.sessionId}`;
  return rememberId(upstreamSessions, key, () => {
    const sessionId = newVscodeSessionId();
    console.log(`[proxy] session ${key} -> ${sessionId}`);
    return sessionId;
  });
}
