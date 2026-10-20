import { createHash, randomUUID } from 'node:crypto';
import { rememberId } from './session.ts';

// grok-build requests are sent upstream shaped like VS Code Chat agent
// requests. grok-build has no subagent header, so the request kind is derived
// from its x-grok-* ids (crates/codegen/xai-grok-sampler/src/client.rs).
export type GrokRequestKind = 'main' | 'subagent' | 'compaction' | 'background';

// VS Code: ChatLocation.Agent for agent turns, subagents and compaction
// (agentIntent.ts), ChatLocation.Panel for title/summary background calls.
const INTENT: Record<GrokRequestKind, string> = {
  main: 'conversation-agent',
  subagent: 'conversation-agent',
  compaction: 'conversation-agent',
  background: 'conversation-panel',
};

const INTERACTION_TYPE: Record<GrokRequestKind, string> = {
  main: 'conversation-agent',
  subagent: 'conversation-subagent',
  compaction: 'conversation-compaction',
  background: 'conversation-background',
};

// x-grok-conv-group-id = uuidv5(NAMESPACE_OID, prefix + root session id)
// (xai-grok-shell/src/sampling/mod.rs), so a session is the root iff its own
// id derives its group id.
const NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';
const CONVERSATION_GROUP_PREFIX = 'xai:grok-build:conversation-group:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type GrokIds = { sessionId: string; convId: string; reqId: string; groupId: string };

function grokIds(req: Request): GrokIds {
  const get = (name: string) => req.headers.get(name)?.trim() ?? '';
  return {
    sessionId: get('x-grok-session-id'),
    convId: get('x-grok-conv-id'),
    reqId: get('x-grok-req-id'),
    groupId: get('x-grok-conv-group-id').toLowerCase(),
  };
}

function requestKind({ sessionId, convId, reqId, groupId }: GrokIds): GrokRequestKind {
  if (reqId.startsWith('xai-compact-')) return 'compaction';
  // Side calls (title refresh, classifiers, memory, goal evaluator) use their
  // own conv id, an `xai-<kind>-` req id, or no req id at all.
  if (!reqId || reqId.startsWith('xai-') || (sessionId && convId !== sessionId)) return 'background';
  if (sessionId && groupId && uuidV5(NAMESPACE_OID, CONVERSATION_GROUP_PREFIX + sessionId) !== groupId) {
    return 'subagent';
  }
  return 'main';
}

const requestIds = new Map<string, string>();
const interactionIds = new Map<string, string>();

export function grokChatHeaders(req: Request, inputEndsWithUserMessage: boolean): {
  kind: GrokRequestKind;
  headers: Record<string, string>;
} {
  const ids = grokIds(req);
  const kind = requestKind(ids);
  const retry = Number(req.headers.get('x-grok-transient-retry') || 0) > 0;
  // VS Code: only iteration 0 of a user turn is `user`; subagents, background
  // calls, system-initiated turns (prefixed req ids) and retries are `agent`.
  const initiator = kind === 'main' && UUID_PATTERN.test(ids.reqId) && inputEndsWithUserMessage && !retry
    ? 'user'
    : 'agent';

  // VS Code: X-Request-Id is one id per user turn (per subagent run for
  // subagents), reused across the tool loop; one-off calls get a fresh id.
  const requestId = kind === 'main' || kind === 'subagent'
    ? rememberId(requestIds, `${ids.sessionId}:${ids.reqId}`, randomUUID)
    : randomUUID();
  const headers: Record<string, string> = {
    'OpenAI-Intent': INTENT[kind],
    'X-Interaction-Type': INTERACTION_TYPE[kind],
    'X-Initiator': initiator,
    'X-Request-Id': requestId,
    'X-Agent-Task-Id': requestId,
  };

  // VS Code: X-Interaction-Id restarts with each user turn and is shared by
  // that turn's subagents and background calls.
  const groupKey = ids.groupId || ids.sessionId;
  if (groupKey) {
    if (initiator === 'user') interactionIds.delete(groupKey);
    headers['X-Interaction-Id'] = rememberId(interactionIds, groupKey, randomUUID);
  }
  return { kind, headers };
}
