import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import app from '../src/server.ts';
import { getCopilotToken } from '../src/copilot-token.ts';

type CapturedCall = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
};

const originalFetch = globalThis.fetch;
const calls: CapturedCall[] = [];
let tokenCalls = 0;
let failTokenExchange = true;

function request(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers,
    body,
  }));
}

beforeAll(() => {
  Bun.env.DISABLE_INPUT_AUTH = 'true';
  Bun.env.DISABLE_USAGE_LOGGING = 'true';
  Bun.env.GITHUB_TOKEN = 'github-token';
  Bun.env.VSCODE_MACHINE_ID = 'machine-id';
  Bun.env.EDITOR_DEVICE_ID = 'device-id';

  globalThis.fetch = (async (input, init = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (url.includes('/copilot_internal/v2/token')) {
      tokenCalls += 1;
      await Bun.sleep(5);
      if (failTokenExchange) return new Response('temporary failure', { status: 503 });
      return Response.json({
        token: 'copilot-token',
        expires_at: 9_999_999_999,
        endpoints: { api: 'https://capi.test/' },
      });
    }

    calls.push({
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return Response.json({ model: 'upstream-model', usage: { input_tokens: 1 } }, {
      headers: { 'x-request-id': 'upstream-request-id' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('Copilot token refresh', () => {
  test('coalesces concurrent refreshes and retries after failure', async () => {
    const failed = await Promise.allSettled(Array.from({ length: 8 }, () => getCopilotToken()));
    expect(failed.every(result => result.status === 'rejected')).toBe(true);
    expect(tokenCalls).toBe(1);

    failTokenExchange = false;
    const tokens = await Promise.all(Array.from({ length: 8 }, () => getCopilotToken()));
    expect(tokens.every(token => token.token === 'copilot-token')).toBe(true);
    expect(tokenCalls).toBe(2);
  });
});

describe('proxy request contract', () => {
  test('adds CAPI headers and preserves endpoint request bodies', async () => {
    const cases: Array<{
      path: string;
      upstream: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [
      {
        path: '/v1/messages',
        upstream: 'https://capi.test/v1/messages',
        headers: {
          'content-type': 'application/json',
          'anthropic-beta': 'context-1m-2025-08-07',
          'anthropic-version': '2023-06-01',
        },
        body: { model: 'sonnet', messages: [], metadata: { trace: true } },
      },
      {
        path: '/v1/responses',
        upstream: 'https://capi.test/responses',
        headers: { 'content-type': 'application/json' },
        body: { model: 'gpt-5.5', input: 'ping' },
      },
      {
        path: '/v1/chat/completions',
        upstream: 'https://capi.test/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: { model: 'gpt-5.5', messages: [] },
      },
    ];

    for (const item of cases) {
      const response = await request(item.path, JSON.stringify(item.body), item.headers);
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(calls).toHaveLength(3);
    for (const [index, call] of calls.entries()) {
      expect(call.url).toBe(cases[index]?.upstream);
      expect(call.headers.get('content-type')).toBe('application/json');
      expect(call.body).toEqual({
        ...cases[index]?.body,
        ...(index === 0 ? { model: 'claude-sonnet-5' } : {}),
      });
    }
    expect(calls[0]?.headers.get('anthropic-beta')).toBe('context-1m-2025-08-07');
    expect(calls[0]?.headers.has('anthropic-version')).toBe(false);
  });

  test('rejects unsupported or non-object request bodies', async () => {
    const before = calls.length;
    const invalid = await request('/v1/responses', '{', { 'content-type': 'application/json' });
    const array = await request('/v1/responses', '[]', { 'content-type': 'application/json' });
    const text = await request('/v1/responses', '{}', { 'content-type': 'text/plain' });

    expect(invalid.status).toBe(400);
    expect(array.status).toBe(400);
    expect(text.status).toBe(415);
    expect(calls).toHaveLength(before);
  });

  test('accepts structured JSON media types and no longer exposes embeddings', async () => {
    const response = await request('/v1/responses', '{"model":"gpt-5.5"}', {
      'content-type': 'application/problem+json',
    });
    expect(response.status).toBe(200);
    await response.text();

    const embeddings = await request('/v1/embeddings', '{}', { 'content-type': 'application/json' });
    expect(embeddings.status).toBe(404);
  });
});
