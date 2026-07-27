import { describe, expect, test } from 'bun:test';
import {
  isClaudeCodeRequest,
  listClaudeCodeModels,
  toClaudeModelsResponse,
} from './claude-models.ts';

const capiPayload = {
  object: 'list',
  data: [
    {
      id: 'claude-opus-4.6',
      name: 'Claude Opus 4.6',
      model_picker_enabled: true,
      supported_endpoints: ['/v1/messages', '/chat/completions'],
      policy: { state: 'enabled' },
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      model_picker_enabled: true,
      supported_endpoints: ['/v1/messages'],
    },
    {
      id: 'claude-haiku-4.5',
      name: 'Claude Haiku 4.5',
      model_picker_enabled: true,
      supported_endpoints: ['/v1/messages'],
    },
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      model_picker_enabled: true,
      supported_endpoints: ['/v1/messages', '/responses'],
    },
    {
      id: 'claude-hidden',
      name: 'Claude Hidden',
      model_picker_enabled: false,
      supported_endpoints: ['/v1/messages'],
    },
    {
      id: 'claude-chat-only',
      name: 'Claude Chat Only',
      model_picker_enabled: true,
      supported_endpoints: ['/chat/completions'],
    },
    {
      id: 'claude-disabled',
      name: 'Claude Disabled',
      model_picker_enabled: true,
      supported_endpoints: ['/v1/messages'],
      policy: { state: 'unconfigured' },
    },
  ],
};

describe('Claude Code models catalog', () => {
  test('keeps only picker-enabled Claude models served on /v1/messages', () => {
    const result = toClaudeModelsResponse(capiPayload);

    expect(result.data).toEqual([
      { type: 'model', id: 'claude-opus-4.6', display_name: 'Claude Opus 4.6' },
      { type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
      { type: 'model', id: 'claude-haiku-4.5', display_name: 'Claude Haiku 4.5' },
    ]);
    expect(result).toMatchObject({
      has_more: false,
      first_id: 'claude-opus-4.6',
      last_id: 'claude-haiku-4.5',
    });
  });

  test('orders by family then by descending version', () => {
    const ids = [
      'claude-sonnet-4.5',
      'claude-haiku-4.5',
      'claude-opus-4.6',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4.8',
    ];
    const result = toClaudeModelsResponse({
      data: ids.map(id => ({
        id,
        name: id,
        model_picker_enabled: true,
        supported_endpoints: ['/v1/messages'],
      })),
    });

    expect(result.data.map(model => model.id)).toEqual([
      'claude-opus-5',
      'claude-opus-4.8',
      'claude-opus-4.6',
      'claude-sonnet-5',
      'claude-sonnet-4.5',
      'claude-haiku-4.5',
    ]);
  });

  test('falls back to the id when CAPI omits a display name', () => {
    const result = toClaudeModelsResponse({
      data: [{ id: 'claude-opus-5', model_picker_enabled: true, supported_endpoints: ['/v1/messages'] }],
    });

    expect(result.data[0]).toEqual({
      type: 'model',
      id: 'claude-opus-5',
      display_name: 'claude-opus-5',
    });
  });

  test('applies the discovery limit and reports pagination', () => {
    const result = toClaudeModelsResponse(capiPayload, 2);

    expect(result.data.map(model => model.id)).toEqual(['claude-opus-4.6', 'claude-sonnet-5']);
    expect(result.has_more).toBe(true);
    expect(result.last_id).toBe('claude-sonnet-5');
  });

  test('returns an empty catalog for malformed payloads', () => {
    expect(toClaudeModelsResponse(null)).toEqual({
      data: [],
      has_more: false,
      first_id: null,
      last_id: null,
    });
  });

  test('serves the discovery request from models.json', async () => {
    const response = await listClaudeCodeModels(
      new Request('http://localhost/v1/models?limit=1000', {
        headers: { 'x-api-key': 'test-key' },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=14400');

    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every(model => model.id.startsWith('claude'))).toBe(true);
  });
});

describe('Claude Code detection', () => {
  const detect = (headers: Record<string, string>) =>
    isClaudeCodeRequest(new Request('http://localhost/v1/models?limit=1000', { headers }));

  test('matches Claude Code request headers', () => {
    // Real discovery headers (claude 2.1.212 gatewayDiscovery), both credential modes.
    expect(
      detect({
        authorization: 'Bearer sk-ant-test',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-code/2.1.212',
      }),
    ).toBe(true);
    expect(
      detect({
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01',
        'user-agent': 'claude-code/2.1.212',
      }),
    ).toBe(true);

    expect(detect({ 'user-agent': 'claude-cli/2.1.212 (external, cli)' })).toBe(true);
    expect(detect({ 'x-app': 'cli' })).toBe(true);
    expect(detect({ 'x-claude-code-session-id': 'abc' })).toBe(true);
    expect(detect({ 'anthropic-version': '2023-06-01' })).toBe(true);
    expect(detect({ 'x-api-key': 'sk-test' })).toBe(true);
  });

  test('does not match Codex CLI requests', () => {
    expect(
      detect({
        'user-agent': 'codex_cli_rs/0.104.0 (Mac OS 26.0; arm64)',
        authorization: 'Bearer sk-test',
        originator: 'codex_cli_rs',
      }),
    ).toBe(false);
    expect(detect({ authorization: 'Bearer sk-test' })).toBe(false);
    expect(detect({})).toBe(false);
  });
});
