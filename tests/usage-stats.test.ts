import { expect, test } from 'bun:test';
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
  expect(cost).toBeCloseTo(19.38, 8);
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
  expect(short).toBeCloseTo(0.355, 8);
  expect(long).toBeCloseTo(1.495005, 8);
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
  expect(cost).toBeCloseTo(0.86, 8);
});
