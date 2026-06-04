import { isRecord } from './proxy.ts';

const STRUCTURED_OUTPUT_NAME = 'structured_output';

type ChatMessage = Record<string, unknown>;
type ClaudeMessage = Record<string, unknown>;

export class StructuredOutputAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputAdapterError';
  }
}

function fail(message: string): never {
  throw new StructuredOutputAdapterError(message);
}

function getStructuredOutputFormat(body: Record<string, unknown>): Record<string, unknown> | null {
  const outputConfig = isRecord(body.output_config) ? body.output_config : null;
  const format = isRecord(outputConfig?.format)
    ? outputConfig.format
    : isRecord(body.output_format)
      ? body.output_format
      : null;
  if (!format) return null;

  const type = format.type;
  if (type === 'json_schema' || type === 'json_object') {
    return format;
  }
  return null;
}

export function hasClaudeStructuredOutput(body: Record<string, unknown>): boolean {
  return typeof body.model === 'string' && body.model.startsWith('claude-') && getStructuredOutputFormat(body) !== null;
}

function copyIfPresent(src: Record<string, unknown>, dest: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (src[field] !== undefined) {
      dest[field] = src[field];
    }
  }
}

function normalizeResponseFormatName(value: unknown): string {
  if (typeof value !== 'string') return STRUCTURED_OUTPUT_NAME;
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return normalized || STRUCTURED_OUTPUT_NAME;
}

function toOpenAIResponseFormat(format: Record<string, unknown>): Record<string, unknown> {
  if (format.type === 'json_object') {
    return { type: 'json_object' };
  }

  if (!isRecord(format.schema)) {
    fail('output_config.format.schema must be an object for json_schema structured output');
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: normalizeResponseFormatName(format.name),
      schema: format.schema,
      strict: typeof format.strict === 'boolean' ? format.strict : true,
    },
  };
}

function systemToChatMessages(system: unknown): ChatMessage[] {
  if (system === undefined || system === null) return [];
  if (typeof system === 'string') {
    return system ? [{ role: 'system', content: system }] : [];
  }
  if (Array.isArray(system)) {
    const text = textFromBlocks(system, 'system');
    return text ? [{ role: 'system', content: text }] : [];
  }
  fail('system must be a string or an array of text blocks');
}

function textFromBlocks(blocks: unknown[], context: string): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      fail(`${context} only supports text blocks when converting structured output requests`);
    }
    parts.push(block.text);
  }
  return parts.join('\n');
}

function imageUrlFromSource(source: unknown): string {
  if (!isRecord(source)) {
    fail('image blocks must include a source object');
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return source.url;
  }
  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  fail('image blocks must use url or base64 sources');
}

function chatContentFromParts(parts: Record<string, unknown>[]): unknown {
  if (parts.every(part => part.type === 'text')) {
    return parts.map(part => String(part.text ?? '')).join('\n');
  }
  return parts;
}

function toolResultContentToString(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return textFromBlocks(content, 'tool_result.content');
  }
  return JSON.stringify(content);
}

function convertUserMessage(content: unknown): ChatMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }];
  }
  if (!Array.isArray(content)) {
    fail('user message content must be a string or an array of content blocks');
  }

  const messages: ChatMessage[] = [];
  const parts: Record<string, unknown>[] = [];
  const flushParts = () => {
    if (parts.length === 0) return;
    messages.push({ role: 'user', content: chatContentFromParts(parts.splice(0)) });
  };

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      fail('user message content blocks must include a type');
    }

    if (block.type === 'text') {
      if (typeof block.text !== 'string') fail('text blocks must include text');
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: imageUrlFromSource(block.source) } });
    } else if (block.type === 'tool_result') {
      flushParts();
      if (typeof block.tool_use_id !== 'string') {
        fail('tool_result blocks must include tool_use_id');
      }
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: toolResultContentToString(block.content),
      });
    } else {
      fail(`unsupported user content block type for structured output conversion: ${block.type}`);
    }
  }

  flushParts();
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
}

function convertAssistantMessage(content: unknown): ChatMessage[] {
  if (typeof content === 'string') {
    return [{ role: 'assistant', content }];
  }
  if (!Array.isArray(content)) {
    fail('assistant message content must be a string or an array of content blocks');
  }

  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      fail('assistant message content blocks must include a type');
    }

    if (block.type === 'text') {
      if (typeof block.text !== 'string') fail('text blocks must include text');
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || typeof block.name !== 'string') {
        fail('tool_use blocks must include id and name');
      }
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    } else {
      fail(`unsupported assistant content block type for structured output conversion: ${block.type}`);
    }
  }

  const message: ChatMessage = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('\n') : toolCalls.length > 0 ? null : '',
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return [message];
}

function claudeMessagesToChatMessages(body: Record<string, unknown>): ChatMessage[] {
  if (!Array.isArray(body.messages)) {
    fail('messages must be an array');
  }

  const out: ChatMessage[] = [...systemToChatMessages(body.system)];

  for (const rawMessage of body.messages) {
    if (!isRecord(rawMessage) || typeof rawMessage.role !== 'string') {
      fail('each message must include a role');
    }

    if (rawMessage.role === 'user') {
      out.push(...convertUserMessage(rawMessage.content));
    } else if (rawMessage.role === 'assistant') {
      out.push(...convertAssistantMessage(rawMessage.content));
    } else if (rawMessage.role === 'system') {
      if (typeof rawMessage.content === 'string') {
        out.push({ role: 'system', content: rawMessage.content });
      } else if (Array.isArray(rawMessage.content)) {
        out.push({ role: 'system', content: textFromBlocks(rawMessage.content, 'system message') });
      } else {
        fail('system message content must be a string or an array of text blocks');
      }
    } else {
      fail(`unsupported message role for structured output conversion: ${rawMessage.role}`);
    }
  }

  return out;
}

function convertTools(tools: unknown): Record<string, unknown>[] | undefined {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) fail('tools must be an array');

  return tools.map(tool => {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !isRecord(tool.input_schema)) {
      fail('only custom Claude tools with name and input_schema can be converted to chat/completions tools');
    }

    const fn: Record<string, unknown> = {
      name: tool.name,
      parameters: tool.input_schema,
    };
    if (typeof tool.description === 'string') {
      fn.description = tool.description;
    }
    if (typeof tool.strict === 'boolean') {
      fn.strict = tool.strict;
    }

    return { type: 'function', function: fn };
  });
}

function convertToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined || toolChoice === null) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (!isRecord(toolChoice)) fail('tool_choice must be a string or object');

  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', function: { name: toolChoice.name } };
  }

  fail('unsupported tool_choice for structured output conversion');
}

export function claudeStructuredOutputToChatCompletions(body: Record<string, unknown>): Record<string, unknown> {
  const format = getStructuredOutputFormat(body);
  if (!format) {
    fail('request does not include supported structured output format');
  }

  const out: Record<string, unknown> = {
    stream: false,
    messages: claudeMessagesToChatMessages(body),
    response_format: toOpenAIResponseFormat(format),
  };

  copyIfPresent(body, out, [
    'model',
    'max_tokens',
    'temperature',
    'top_p',
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'n',
    'logprobs',
    'top_logprobs',
    'user',
  ]);

  if (Array.isArray(body.stop_sequences) || typeof body.stop_sequences === 'string') {
    out.stop = body.stop_sequences;
  }

  const tools = convertTools(body.tools);
  if (tools) {
    out.tools = tools;
  }

  const toolChoice = convertToolChoice(body.tool_choice);
  if (toolChoice !== undefined) {
    out.tool_choice = toolChoice;
  }

  return out;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function claudeUsageFromChatUsage(usage: unknown): Record<string, unknown> {
  const raw = isRecord(usage) ? usage : {};
  const completionDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : null;
  const out: Record<string, unknown> = {
    input_tokens: numberOrZero(raw.prompt_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: numberOrZero(raw.completion_tokens),
  };

  if (completionDetails && typeof completionDetails.reasoning_tokens === 'number') {
    out.output_tokens_details = { thinking_tokens: completionDetails.reasoning_tokens };
  }

  return out;
}

function mapFinishReason(reason: unknown, hasRefusal: boolean): string {
  if (hasRefusal) return 'refusal';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function claudeMessageId(id: unknown): string {
  if (typeof id === 'string' && id.startsWith('msg_')) return id;
  if (typeof id === 'string' && id.length > 0) return `msg_${id}`;
  return `msg_${globalThis.crypto.randomUUID()}`;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    return JSON.parse(value);
  } catch {
    return { arguments: value };
  }
}

function contentBlocksFromChatMessage(message: Record<string, unknown>): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  const text = typeof message.content === 'string' ? message.content : null;
  const refusal = typeof message.refusal === 'string' ? message.refusal : null;

  if (text !== null) {
    content.push({ type: 'text', text });
  } else if (refusal !== null) {
    content.push({ type: 'text', text: refusal });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!isRecord(toolCall)) continue;
      const fn = isRecord(toolCall.function) ? toolCall.function : {};
      if (typeof toolCall.id !== 'string' || typeof fn.name !== 'string') continue;
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: fn.name,
        input: parseToolArguments(fn.arguments),
      });
    }
  }

  return content.length > 0 ? content : [{ type: 'text', text: '' }];
}

export function chatCompletionToClaudeMessage(
  completion: Record<string, unknown>,
  requestModel: string | null,
): ClaudeMessage {
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const hasRefusal = typeof message.refusal === 'string';
  const stopReason = mapFinishReason(choice.finish_reason, hasRefusal);
  const out: ClaudeMessage = {
    id: claudeMessageId(completion.id),
    type: 'message',
    role: 'assistant',
    model: requestModel || (typeof completion.model === 'string' ? completion.model : null),
    content: contentBlocksFromChatMessage(message),
    stop_reason: stopReason,
    stop_sequence: null,
    usage: claudeUsageFromChatUsage(completion.usage),
  };

  if (hasRefusal) {
    out.stop_details = {
      type: 'refusal',
      category: null,
      explanation: message.refusal,
    };
  }

  return out;
}

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamStartUsage(usage: unknown): Record<string, unknown> {
  const raw = isRecord(usage) ? usage : {};
  return {
    input_tokens: numberOrZero(raw.input_tokens),
    cache_creation_input_tokens: numberOrZero(raw.cache_creation_input_tokens),
    cache_read_input_tokens: numberOrZero(raw.cache_read_input_tokens),
    output_tokens: 0,
  };
}

function contentBlockEvents(block: Record<string, unknown>, index: number): string {
  if (block.type === 'tool_use') {
    const input = isRecord(block.input) ? block.input : {};
    return [
      sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index }),
    ].join('');
  }

  const text = typeof block.text === 'string' ? block.text : '';
  return [
    sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    }),
    text
      ? sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        })
      : '',
    sse('content_block_stop', { type: 'content_block_stop', index }),
  ].join('');
}

export function chatCompletionToClaudeMessageStream(
  completion: Record<string, unknown>,
  requestModel: string | null,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const message = chatCompletionToClaudeMessage(completion, requestModel);
  const content = Array.isArray(message.content) ? message.content : [];
  const usage = isRecord(message.usage) ? message.usage : {};
  const text = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: message.id,
        type: 'message',
        role: 'assistant',
        model: message.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: streamStartUsage(usage),
      },
    }),
    ...content.map((block, index) => isRecord(block) ? contentBlockEvents(block, index) : ''),
    sse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: message.stop_sequence,
      },
      usage,
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('');

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}
