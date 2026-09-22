import { expect, test } from 'bun:test';
import { stabilizeResponseStream } from '../src/responses-stream';

const encoder = new TextEncoder();
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const source = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(text));
    controller.close();
  },
});
const normalize = (text: string) => new Response(stabilizeResponseStream(source(text))).text();
const parse = (text: string) => text.trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)));

test('stabilizes each output item through deltas and all terminal events', async () => {
  for (const status of ['completed', 'incomplete', 'failed']) {
    const items = [
      { id: 'reasoning-first', type: 'reasoning', encrypted_content: 'opaque' },
      { id: 'tool-first', type: 'function_call', call_id: 'call-original' },
      { id: 'message-first', type: 'message' },
    ];
    const events = items.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_text.delta', output_index, item_id: `delta-${output_index}`, delta: '你好' },
      { type: 'response.output_item.done', output_index, item: { ...item, id: `done-${output_index}` } },
    ]);
    const terminal = {
      type: `response.${status}`,
      response: { id: 'response-original', output: items.map((item, i) => ({ ...item, id: `final-${i}` })) },
    };
    const result = parse(await normalize(events.map(event).join('') + event(terminal)));

    items.forEach((item, i) => {
      expect(result[i * 3]).toEqual(events[i * 3]);
      expect(result[i * 3 + 1]).toEqual({ ...events[i * 3 + 1], item_id: item.id });
      expect(result[i * 3 + 2]).toEqual({ type: 'response.output_item.done', output_index: i, item });
    });
    expect(result.at(-1)).toEqual({ ...terminal, response: { id: 'response-original', output: items } });
  }
});

test('can learn the first ID from item_id and keeps response state independent', async () => {
  const request = (id: string) => [
    { type: 'response.output_text.delta', output_index: 0, item_id: id, delta: 'a' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'changed', type: 'message' } },
  ];
  const results = await Promise.all(['first-request', 'second-request'].map(async id => {
    const events = request(id);
    return { id, events, result: parse(await normalize(events.map(event).join(''))) };
  }));
  for (const { id, events, result } of results) {
    expect(result).toEqual([events[0], { ...events[1], item: { id, type: 'message' } }]);
  }
});

test('decodes split UTF-8 and multiline SSE incrementally, preserving unchanged frames', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const reader = stabilizeResponseStream(upstream).getReader();
  const decoder = new TextDecoder();
  const first = ': heartbeat\r\n\r\nevent: response.output_text.delta\r\n'
    + 'data: {"type":"response.output_text.delta","output_index":0,\r\n'
    + 'data: "item_id":"first","delta":"你好"}\r\n\r\n';
  // Single-byte chunks split both multibyte characters and CRLF boundaries.
  for (const byte of encoder.encode(first)) controller.enqueue(Uint8Array.of(byte));
  let received = '';
  while (received.length < first.length) {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    received += decoder.decode(value, { stream: true });
  }
  expect(received).toBe(first);

  const changed = { type: 'response.output_text.delta', output_index: 0, item_id: 'changed', delta: '世界' };
  const metadata = 'event: response.output_text.delta\r: keep this comment\r';
  const multiline = metadata
    + 'data: {"type":"response.output_text.delta","output_index":0,\r'
    + 'data: "item_id":"changed","delta":"世界"}\r\r';
  controller.enqueue(encoder.encode(multiline + 'data: [DONE]\n\n'));
  controller.close();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  rest += decoder.decode();
  expect(rest).toBe(metadata + `data: ${JSON.stringify({ ...changed, item_id: 'first' })}\r\r` + 'data: [DONE]\n\n');
});
