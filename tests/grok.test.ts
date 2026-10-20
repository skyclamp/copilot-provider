import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grokChatHeaders } from '../src/grok.ts';

// Frozen vector from grok-build's derivation_is_stable_and_frozen test.
const ROOT = 'root-session-123';
const GROUP = '111fc242-925b-5a7d-826e-2974daad239f';
const CHILD = '019a0000-0000-7000-8000-000000000002';
const PROMPT = '6f1c9a2e-3b4d-4e5f-8a6b-7c8d9e0f1a2b';

const request = (headers: Record<string, string>) => new Request('http://localhost/responses', {
  method: 'POST',
  headers: { 'x-grok-conv-group-id': GROUP, ...headers },
});
const root = (headers: Record<string, string> = {}) =>
  request({ 'x-grok-session-id': ROOT, 'x-grok-conv-id': ROOT, 'x-grok-req-id': PROMPT, ...headers });

test('root turn: user only on the first request, request id stable across the tool loop', () => {
  const first = grokChatHeaders(root(), true);
  const followUp = grokChatHeaders(root(), false);
  assert.equal(first.kind, 'main');
  assert.equal(first.headers['OpenAI-Intent'], 'conversation-agent');
  assert.equal(first.headers['X-Interaction-Type'], 'conversation-agent');
  assert.equal(first.headers['X-Initiator'], 'user');
  assert.equal(followUp.headers['X-Initiator'], 'agent');
  assert.equal(followUp.headers['X-Request-Id'], first.headers['X-Request-Id']);
  assert.equal(first.headers['X-Agent-Task-Id'], first.headers['X-Request-Id']);
  assert.equal(followUp.headers['X-Interaction-Id'], first.headers['X-Interaction-Id']);
});

test('subagent: own session id whose uuidv5 does not derive the group', () => {
  const parent = grokChatHeaders(root({ 'x-grok-req-id': crypto.randomUUID() }), true);
  const child = grokChatHeaders(request({
    'x-grok-session-id': CHILD, 'x-grok-conv-id': CHILD, 'x-grok-req-id': '019a0000-0000-7000-8000-0000000000aa',
  }), true);
  assert.equal(child.kind, 'subagent');
  assert.equal(child.headers['OpenAI-Intent'], 'conversation-agent');
  assert.equal(child.headers['X-Interaction-Type'], 'conversation-subagent');
  assert.equal(child.headers['X-Initiator'], 'agent');
  assert.notEqual(child.headers['X-Request-Id'], parent.headers['X-Request-Id']);
  assert.equal(child.headers['X-Interaction-Id'], parent.headers['X-Interaction-Id']);
});

test('a new user turn starts a new interaction id', () => {
  const turn1 = grokChatHeaders(root({ 'x-grok-req-id': crypto.randomUUID() }), true);
  const turn2 = grokChatHeaders(root({ 'x-grok-req-id': crypto.randomUUID() }), true);
  assert.notEqual(turn2.headers['X-Interaction-Id'], turn1.headers['X-Interaction-Id']);
  assert.notEqual(turn2.headers['X-Request-Id'], turn1.headers['X-Request-Id']);
});

test('side calls are background or compaction, always agent with fresh request ids', () => {
  const cases: [Record<string, string>, string, string][] = [
    [{ 'x-grok-conv-id': `title-refresh-${crypto.randomUUID()}`, 'x-grok-req-id': `xai-title-refresh-${crypto.randomUUID()}` }, 'background', 'conversation-background'],
    [{ 'x-grok-conv-id': `trace-classifier-${crypto.randomUUID()}`, 'x-grok-req-id': '' }, 'background', 'conversation-background'],
    [{ 'x-grok-req-id': '' }, 'background', 'conversation-background'],
    [{ 'x-grok-req-id': `xai-compact-${crypto.randomUUID()}` }, 'compaction', 'conversation-compaction'],
  ];
  for (const [headers, kind, interactionType] of cases) {
    const a = grokChatHeaders(root(headers), true);
    const b = grokChatHeaders(root(headers), true);
    assert.equal(a.kind, kind);
    assert.equal(a.headers['X-Interaction-Type'], interactionType);
    assert.equal(a.headers['OpenAI-Intent'], kind === 'background' ? 'conversation-panel' : 'conversation-agent');
    assert.equal(a.headers['X-Initiator'], 'agent');
    assert.notEqual(a.headers['X-Request-Id'], b.headers['X-Request-Id']);
  }
});

test('system-initiated turns and transient retries are agent', () => {
  assert.equal(grokChatHeaders(root({ 'x-grok-req-id': `goal-summary-${crypto.randomUUID()}` }), true).headers['X-Initiator'], 'agent');
  assert.equal(grokChatHeaders(root({ 'x-grok-transient-retry': '1' }), true).headers['X-Initiator'], 'agent');
});
