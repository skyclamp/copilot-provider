import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

test('standalone proxy normalizes Responses SSE without local imports', async () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'first', type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'rotated', delta: '你好' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'done', type: 'message' } },
    { type: 'response.completed', response: { id: 'response-id', output: [{ id: 'final', type: 'message' }] } },
  ];
  const sse = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  let upstream = new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  let handle!: (req: Request) => Promise<Response>;
  const source = await Bun.file(new URL('../standalone-proxies/responses-proxy.ts', import.meta.url)).text();
  runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(source), {
    Bun: {
      argv: ['bun', 'responses-proxy.ts', '--github-token', 'test-token'],
      env: {},
      serve(options: { fetch: typeof handle }) {
        handle = options.fetch;
        return { port: 4141 };
      },
    },
    crypto, URL, Response, Headers, TextDecoder, TextEncoder, TransformStream,
    console: { log() {}, error() {} },
    fetch: async (url: string) => url.endsWith('/copilot_internal/v2/token')
      ? Response.json({ token: 'copilot-test-token', expires_at: Date.now() / 1000 + 3600 })
      : upstream,
  });
  const request = () => new Request('http://localhost/responses', {
    method: 'POST', body: JSON.stringify({ model: 'test-model', stream: true }),
  });
  const response = await handle(request());
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const result = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)));
  expect(result).toEqual([
    events[0],
    { ...events[1], item_id: 'first' },
    { ...events[2], item: { id: 'first', type: 'message' } },
    { ...events[3], response: { id: 'response-id', output: [{ id: 'first', type: 'message' }] } },
  ]);

  // JSON and upstream errors must still pass through without SSE parsing.
  for (const status of [200, 429]) {
    upstream = new Response('{"unchanged":true}', { status, headers: { 'Content-Type': 'application/json' } });
    const result = await handle(request());
    expect(result.status).toBe(status);
    expect(await result.text()).toBe('{"unchanged":true}');
  }
});
