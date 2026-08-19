import { expect, test } from 'bun:test';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSessionEventLogger, flushSessionLogs } from '../src/session-log.ts';

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);

test('session logger batches ordered lifecycle events without delaying response EOF', async () => {
  const sessionId = `test-${crypto.randomUUID()}`;
  const path = resolve(MODULE_DIR, '..', 'logs', `cx-${sessionId}.jsonl`);
  const logger = createSessionEventLogger(new Request('http://localhost/v1/responses', {
    headers: { 'session-id': sessionId, authorization: 'Bearer secret' },
  }));
  expect(logger).not.toBeNull();

  logger!.request('POST', '/v1/responses');
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 100; i += 1) controller.enqueue(new Uint8Array([i]));
      controller.close();
    },
  });
  const response = await logger!.response(new Response(source));
  await response.arrayBuffer();
  await flushSessionLogs();

  const records = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
  expect(records.map(record => record.event)).toEqual([
    'request',
    'response_start',
    ...Array.from({ length: 100 }, () => 'chunk'),
    'response_end',
  ]);
  expect((records[0]?.headers as Record<string, string>).authorization).toBe('[REDACTED]');
  expect(records.at(-1)?.complete).toBe(true);

  await unlink(path);
});
