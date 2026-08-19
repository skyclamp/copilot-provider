import { describe, expect, test } from 'bun:test';
import { SSEUsageParser } from '../src/usage.ts';

describe('SSEUsageParser', () => {
  test.each(['\n', '\r\n', '\r'])('parses %j line endings', newline => {
    const parser = new SSEUsageParser();
    parser.feed([
      'event: message_start',
      'data: {"message":{"model":"claude-sonnet-5","usage":{"input_tokens":10}}}',
      '',
      'event: message_delta',
      'data: {"usage":{"output_tokens":3}}',
      '',
      '',
    ].join(newline));
    parser.finish();

    expect(parser.result()).toEqual({
      model: 'claude-sonnet-5',
      usage: { input_tokens: 10, output_tokens: 3 },
    });
  });

  test('handles boundaries split across chunks and the final unterminated event', () => {
    const parser = new SSEUsageParser();
    parser.feed('event: response.created\r\ndata: {"type":"response.created","response":{"model":"gpt-5.5"}}\r');
    parser.feed('\n\r');
    parser.feed('\nevent: response.completed\ndata: {"type":"response.completed","response":');
    parser.feed('{"usage":{"input_tokens":7,"output_tokens":2}}}');
    parser.finish();

    expect(parser.result()).toEqual({
      model: 'gpt-5.5',
      usage: { input_tokens: 7, output_tokens: 2 },
    });
  });

  test('joins multiline data fields according to the SSE specification', () => {
    const parser = new SSEUsageParser();
    parser.feed('data: {"object":"chat.completion.chunk",\n');
    parser.feed('data: "model":"gpt-5.5","usage":{"completion_tokens":4}}\n\n');
    parser.finish();

    expect(parser.result()).toEqual({
      model: 'gpt-5.5',
      usage: { completion_tokens: 4 },
    });
  });
});
