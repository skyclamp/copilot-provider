/**
 * CAPI probe for the Anthropic `web_search` server tool.
 *
 * Sends an Anthropic-shaped request directly to Copilot's upstream
 * /v1/messages (no local proxy involved — see `capi_tests/_lib/capi.ts`) so we
 * can see whether CAPI honours `web_search` as a server tool, what error /
 * payload comes back, and which content blocks (`server_tool_use`,
 * `web_search_tool_result`, …) get emitted.
 *
 * Exits 0 only when CAPI returns 2xx; any non-2xx is treated as failure of
 * the upstream feature and the script exits non-zero.
 *
 * Usage:
 *   bun run capi_tests/claude/server-tools/web-search.ts            # non-streaming
 *   bun run capi_tests/claude/server-tools/web-search.ts --stream   # SSE
 *
 * Anthropic docs:
 *   https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */

import { callCapiMessages } from '../../_lib/capi.ts';

const MODEL = 'claude-opus-4.7';
const TOOL_VERSION = 'web_search_20260209';
const PROMPT =
  'Search the web for the latest stable Bun release version and its release date, ' +
  'then summarise in one sentence with a citation.';

type ClaudeContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  url?: string;
  title?: string;
  content?: unknown;
  error_code?: string;
  [key: string]: unknown;
};

type ClaudeMessageResponse = {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  stop_reason?: string | null;
  content?: ClaudeContentBlock[];
  usage?: Record<string, unknown>;
};

function parseArgs(argv: string[]): { stream: boolean } {
  return { stream: argv.includes('--stream') };
}

function buildBody(stream: boolean): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 1024,
    stream,
    messages: [{ role: 'user', content: PROMPT }],
    tools: [{ type: TOOL_VERSION, name: 'web_search', max_uses: 3 }],
  };
}

function previewText(text: string, max = 400): string {
  if (text.length <= max) return JSON.stringify(text);
  return `${JSON.stringify(text.slice(0, max))}… (+${text.length - max} chars)`;
}

function summariseContent(blocks: ClaudeContentBlock[] | undefined): void {
  if (!blocks?.length) {
    console.log('(no content blocks)');
    return;
  }
  for (const [i, block] of blocks.entries()) {
    const head = `  [${i}] type=${block.type}`;
    if (block.type === 'text' && typeof block.text === 'string') {
      console.log(`${head} text=${previewText(block.text)}`);
    } else if (block.type === 'server_tool_use') {
      console.log(`${head} name=${String(block.name ?? '')} input=${JSON.stringify(block.input ?? {})}`);
    } else if (block.type === 'web_search_tool_result') {
      const results = Array.isArray(block.content) ? (block.content as ClaudeContentBlock[]) : [];
      console.log(`${head} tool_use_id=${block.tool_use_id ?? ''} results=${results.length}`);
      for (const [j, r] of results.entries()) {
        if (r?.type === 'web_search_result') {
          console.log(`        (${j}) ${r.title ?? ''} — ${r.url ?? ''}`);
        } else if (r?.type === 'web_search_tool_result_error') {
          console.log(`        (${j}) ERROR: ${JSON.stringify(r)}`);
        } else {
          console.log(`        (${j}) ${JSON.stringify(r).slice(0, 200)}`);
        }
      }
    } else {
      console.log(`${head} ${JSON.stringify(block).slice(0, 300)}`);
    }
  }
}

async function runNonStreaming(stream: boolean): Promise<void> {
  const started = performance.now();
  const { resp, url } = await callCapiMessages({ body: buildBody(stream) });
  const elapsedMs = Math.round(performance.now() - started);
  const text = await resp.text();
  console.log(`POST ${url}`);
  console.log(`status=${resp.status} elapsed=${elapsedMs}ms`);

  if (!resp.ok) {
    console.error('upstream error body:');
    console.error(text);
    process.exit(1);
  }

  let parsed: ClaudeMessageResponse;
  try {
    parsed = JSON.parse(text) as ClaudeMessageResponse;
  } catch (err) {
    console.error('failed to parse JSON response:', err);
    console.error(text);
    process.exit(1);
  }

  console.log(`model=${parsed.model ?? ''} stop_reason=${parsed.stop_reason ?? '(none)'}`);
  console.log('content:');
  summariseContent(parsed.content);
  if (parsed.usage) console.log(`usage=${JSON.stringify(parsed.usage)}`);
}

async function runStreaming(stream: boolean): Promise<void> {
  const started = performance.now();
  const { resp, url } = await callCapiMessages({ body: buildBody(stream), stream: true });
  console.log(`POST ${url}`);
  console.log(`status=${resp.status}`);

  if (!resp.ok || !resp.body) {
    const errText = await resp.text();
    console.error('upstream error body:');
    console.error(errText);
    process.exit(1);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventCount = 0;
  const seenEventTypes = new Set<string>();
  const seenBlockTypes = new Set<string>();
  const searchQueries: string[] = [];
  const searchResults: { title?: string; url?: string }[] = [];
  let textOut = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      eventCount += 1;

      let eventType = '';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (eventType) seenEventTypes.add(eventType);
      if (!dataLines.length) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }

      if (eventType === 'content_block_start') {
        const block = payload.content_block as ClaudeContentBlock | undefined;
        if (block?.type) seenBlockTypes.add(block.type);
        if (block?.type === 'server_tool_use') {
          const input = (block as { input?: { query?: string } }).input;
          if (input?.query) searchQueries.push(input.query);
        } else if (block?.type === 'web_search_tool_result') {
          const results = Array.isArray(block.content) ? (block.content as ClaudeContentBlock[]) : [];
          for (const r of results) {
            if (r?.type === 'web_search_result') {
              searchResults.push({ title: r.title as string | undefined, url: r.url as string | undefined });
            }
          }
        }
      } else if (eventType === 'content_block_delta') {
        const delta = payload.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          textOut += delta.text;
        }
      }
    }
  }

  const elapsedMs = Math.round(performance.now() - started);
  console.log(`elapsed=${elapsedMs}ms events=${eventCount}`);
  console.log(`event types: ${[...seenEventTypes].join(', ')}`);
  console.log(`block types: ${[...seenBlockTypes].join(', ') || '(none)'}`);
  if (searchQueries.length) {
    console.log(`search queries (${searchQueries.length}):`);
    for (const [i, q] of searchQueries.entries()) console.log(`  [${i}] ${q}`);
  }
  if (searchResults.length) {
    console.log(`search results (${searchResults.length}):`);
    for (const [i, r] of searchResults.entries()) {
      console.log(`  [${i}] ${r.title ?? ''} — ${r.url ?? ''}`);
    }
  }
  if (textOut) {
    console.log('assistant text:');
    console.log(textOut);
  }
}

async function main(): Promise<void> {
  const { stream } = parseArgs(process.argv.slice(2));
  console.log(`model=${MODEL} tool=${TOOL_VERSION} stream=${stream}`);
  console.log(`prompt: ${PROMPT}`);
  console.log('---');
  if (stream) await runStreaming(stream);
  else await runNonStreaming(stream);
}

main().catch(err => {
  console.error('probe failed:', err);
  process.exit(1);
});
