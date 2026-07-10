import { describe, expect, test } from 'bun:test';
import {
  CodexModelsCatalog,
  MODELS_CACHE_TTL_MS,
  listCodexModels,
  toCodexModelsResponse,
} from './models.ts';
import app from './server.ts';

const eligibleModel = {
  id: 'gpt-5.6-sol',
  name: 'GPT-5.6 Sol',
  vendor: 'OpenAI',
  model_picker_enabled: true,
  supported_endpoints: ['/responses', 'ws:/responses'],
  capabilities: {
    limits: {
      max_context_window_tokens: 1_050_000,
      max_prompt_tokens: 922_000,
    },
    supports: {
      parallel_tool_calls: true,
      reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      tool_calls: true,
      vision: true,
    },
  },
};

describe('Codex models catalog', () => {
  test('maps CAPI metadata to the Codex model schema', () => {
    const result = toCodexModelsResponse({
      object: 'list',
      data: [
        eligibleModel,
        {
          ...eligibleModel,
          id: 'chat-only',
          supported_endpoints: ['/chat/completions'],
        },
        {
          ...eligibleModel,
          id: 'hidden',
          model_picker_enabled: false,
        },
        {
          ...eligibleModel,
          id: 'disabled',
          policy: { state: 'disabled' },
        },
      ],
    });

    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6 Sol',
      default_reasoning_level: 'medium',
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      support_verbosity: true,
      default_verbosity: 'low',
      apply_patch_tool_type: 'freeform',
      supports_parallel_tool_calls: true,
      context_window: 922_000,
      max_context_window: 1_050_000,
      input_modalities: ['text', 'image'],
    });
    expect(result.models[0].supported_reasoning_levels.map(item => item.effort)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(result.models[0].base_instructions).not.toBeEmpty();
  });

  test('only returns whitelisted models in descending performance order', () => {
    const ids = [
      'mai-code-1-flash-picker',
      'future-model',
      'gpt-5-mini',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.4',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ];
    const result = toCodexModelsResponse({
      data: ids.map(id => ({ ...eligibleModel, id, name: id })),
    });

    expect(result.models.map(model => model.slug)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
      'gpt-5-mini',
      'mai-code-1-flash-picker',
    ]);
    expect(result.models.map(model => model.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('caches a successful catalog for four hours and coalesces refreshes', async () => {
    let now = 1_000;
    let calls = 0;
    const loader = async () => {
      calls++;
      await Promise.resolve();
      return { data: [eligibleModel] };
    };
    const catalog = new CodexModelsCatalog(loader, () => now);
    const req = new Request('http://localhost/v1/models');

    const [first, concurrent] = await Promise.all([catalog.get(req), catalog.get(req)]);
    expect(first).toBe(concurrent);
    expect(calls).toBe(1);

    now += MODELS_CACHE_TTL_MS - 1;
    expect(await catalog.get(req)).toBe(first);
    expect(calls).toBe(1);

    now += 2;
    expect(await catalog.get(req)).not.toBe(first);
    expect(calls).toBe(2);
  });

  test('releases a timed-out refresh so the next request can retry', async () => {
    let calls = 0;
    const catalog = new CodexModelsCatalog(
      async (_req, signal) => {
        calls++;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      Date.now,
      MODELS_CACHE_TTL_MS,
      5,
    );
    const req = new Request('http://localhost/v1/models');

    await expect(catalog.get(req)).rejects.toThrow('timed out');
    await expect(catalog.get(req)).rejects.toThrow('timed out');
    expect(calls).toBe(2);
  });

  test('returns the Codex wrapper from the HTTP handler', async () => {
    const catalog = new CodexModelsCatalog(async () => ({ data: [eligibleModel] }));
    const response = await listCodexModels(
      new Request('http://localhost/v1/models?client_version=0.0.0'),
      catalog,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=14400');
    expect(await response.json()).toMatchObject({
      models: [{ slug: 'gpt-5.6-sol' }],
    });
  });

  test('does not expose the unversioned models route', async () => {
    const response = await app.fetch(new Request('http://localhost/models'));

    expect(response.status).toBe(404);
  });
});
