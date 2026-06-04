import { describe, expect, test } from 'bun:test';
import {
  chatCompletionToClaudeMessage,
  chatCompletionToClaudeMessageStream,
  claudeStructuredOutputToChatCompletions,
  hasClaudeStructuredOutput,
} from './messages-structured-output.ts';

describe('messages structured output adapters', () => {
  test('converts Claude structured output requests to non-streaming chat completions requests', () => {
    const request = {
      model: 'claude-opus-4.8',
      max_tokens: 512,
      stream: true,
      temperature: 0.2,
      stop_sequences: ['END'],
      system: [{ type: 'text', text: 'Return JSON.' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the fields.' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          name: 'contact info',
          strict: false,
          schema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    };

    expect(hasClaudeStructuredOutput(request)).toBe(true);

    const converted = claudeStructuredOutputToChatCompletions(request);

    expect(converted.stream).toBe(false);
    expect(converted.model).toBe('claude-opus-4.8');
    expect(converted.max_tokens).toBe(512);
    expect(converted.temperature).toBe(0.2);
    expect(converted.stop).toEqual(['END']);
    expect(converted.messages).toEqual([
      { role: 'system', content: 'Return JSON.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the fields.' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      },
    ]);
    expect(converted.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'contact_info',
        strict: false,
        schema: request.output_config.format.schema,
      },
    });
  });

  test('converts chat completions responses to Claude messages responses', () => {
    const converted = chatCompletionToClaudeMessage(
      {
        id: 'chatcmpl-123',
        model: 'claude-opus-4.8',
        choices: [
          {
            message: { role: 'assistant', content: '{"name":"Ada"}' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      },
      'claude-opus-4.8',
    );

    expect(converted).toEqual({
      id: 'msg_chatcmpl-123',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.8',
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 11,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 7,
        output_tokens_details: { thinking_tokens: 2 },
      },
    });
  });

  test('converts non-streaming chat completions responses to Claude SSE streams', async () => {
    const stream = chatCompletionToClaudeMessageStream(
      {
        id: 'chatcmpl-456',
        model: 'claude-opus-4.8',
        choices: [
          {
            message: { role: 'assistant', content: '{"ok":true}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
      'claude-opus-4.8',
    );

    const text = await new Response(stream).text();

    expect(text).toContain('event: message_start\n');
    expect(text).toContain('"id":"msg_chatcmpl-456"');
    expect(text).toContain('event: content_block_start\n');
    expect(text).toContain('"delta":{"type":"text_delta","text":"{\\"ok\\":true}"}');
    expect(text).toContain('event: content_block_stop\n');
    expect(text).toContain('"delta":{"stop_reason":"end_turn","stop_sequence":null}');
    expect(text).toContain('"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":3}');
    expect(text).toContain('event: message_stop\n');
  });
});
