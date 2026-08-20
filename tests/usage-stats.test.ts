import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeClaudeEntryCost,
  computeGrokEntryCost,
  computeOpenAIEntryCost,
} from '../scripts/usage-stats.ts';

test('computes Claude cache write and read pricing without double counting', () => {
  const cost = computeClaudeEntryCost({
    model: 'claude-sonnet-4.6',
    usage: {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 300_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 100_000,
        ephemeral_1h_input_tokens: 100_000,
      },
      cache_read_input_tokens: 100_000,
    },
  });
  assert.ok(Math.abs(cost - 19.38) < 1e-8);
});

test('computes OpenAI cached input and long-context pricing', () => {
  const short = computeOpenAIEntryCost({
    model: 'gpt-5.4',
    usage: {
      input_tokens: 100_000,
      input_tokens_details: { cached_tokens: 20_000 },
      output_tokens: 10_000,
    },
  });
  const long = computeOpenAIEntryCost({
    model: 'gpt-5.4',
    usage: {
      input_tokens: 272_001,
      input_tokens_details: { cached_tokens: 20_000 },
      output_tokens: 10_000,
    },
  });
  assert.ok(Math.abs(short - 0.355) < 1e-8);
  assert.ok(Math.abs(long - 1.495005) < 1e-8);
});

test('uses xAI long-context pricing at the inclusive boundary', () => {
  const cost = computeGrokEntryCost({
    model: 'grok-4.6',
    usage: {
      input_tokens: 200_000,
      input_tokens_details: { cached_tokens: 20_000 },
      output_tokens: 10_000,
    },
  });
  assert.ok(Math.abs(cost - 0.86) < 1e-8);
});
