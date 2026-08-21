/**
 * CAPI probe for the Anthropic `web_fetch` server tool.
 *
 * Sends an Anthropic-shaped request directly to Copilot's upstream
 * /v1/messages (no local proxy involved — see `capi_tests/_lib/capi.ts`) so we
 * can see whether CAPI honours `web_fetch` as a server tool, what error /
 * payload comes back, and which content blocks (`server_tool_use`,
 * `web_fetch_tool_result`, …) get emitted.
 *
 * Exits 0 only when CAPI returns 2xx; any non-2xx is treated as failure of
 * the upstream feature and the script exits non-zero.
 *
 * Usage:
 *   bun run capi_tests/claude/server-tools/web-fetch.ts            # non-streaming
 *   bun run capi_tests/claude/server-tools/web-fetch.ts --stream   # SSE
 *
 * Anthropic docs:
 *   https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
 */

import { callCapiMessages } from '../../_lib/capi.ts';

const MODEL = 'claude-opus-4.7';
const TOOL_VERSION = 'web_fetch_20260209';
const TARGET_URL = 'https://bun.sh';
const PROMPT = `Fetch the page at ${TARGET_URL} and summarise the first paragraph in one sentence.`;

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
    tools: [{ type: TOOL_VERSION, name: 'web_fetch', max_uses: 1 }],
  };
}

function previewText(text: string, max = 400): string {
  if (text.length <= max) return JSON.stringify(text);
  return `${JSON.stringify(text.slice(0, max))}… (+${text.length - max} chars)`;
}

function summariseFetchResult(block: ClaudeContentBlock, indent: string): void {
  const content = block.content as
    | { type?: string; url?: string; error_code?: string; content?: unknown }
    | undefined;
  if (!content) {
    console.log(`${indent}(empty result)`);
    return;
  }
  if (content.type === 'web_fetch_tool_error') {
    console.log(`${indent}ERROR error_code=${content.error_code ?? ''}`);
    return;
  }
  if (content.type === 'web_fetch_result') {
    console.log(`${indent}url=${content.url ?? ''}`);
    const inner = content.content as { type?: string; source?: { media_type?: string; data?: string } } | undefined;
    if (inner?.type === 'document' && inner.source) {
      const data = typeof inner.source.data === 'string' ? inner.source.data : '';
      console.log(`${indent}media_type=${inner.source.media_type ?? ''} body=${previewText(data)}`);
    } else {
      console.log(`${indent}${JSON.stringify(inner).slice(0, 300)}`);
    }
    return;
  }
  console.log(`${indent}${JSON.stringify(content).slice(0, 300)}`);
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
    } else if (block.type === 'web_fetch_tool_result') {
      console.log(`${head} tool_use_id=${block.tool_use_id ?? ''}`);
      summariseFetchResult(block, '        ');
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
  const fetchUrls: string[] = [];
  const fetchResults: { url?: string; mediaType?: string; bytes?: number; error?: string }[] = [];
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
          const input = (block as { input?: { url?: string } }).input;
          if (input?.url) fetchUrls.push(input.url);
        } else if (block?.type === 'web_fetch_tool_result') {
          const content = block.content as
            | { type?: string; url?: string; error_code?: string; content?: { source?: { media_type?: string; data?: string } } }
            | undefined;
          if (content?.type === 'web_fetch_tool_error') {
            fetchResults.push({ url: content.url, error: content.error_code });
          } else if (content?.type === 'web_fetch_result') {
            const src = content.content?.source;
            fetchResults.push({
              url: content.url,
              mediaType: src?.media_type,
              bytes: typeof src?.data === 'string' ? src.data.length : undefined,
            });
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
  if (fetchUrls.length) {
    console.log(`fetch requests (${fetchUrls.length}):`);
    for (const [i, u] of fetchUrls.entries()) console.log(`  [${i}] ${u}`);
  }
  if (fetchResults.length) {
    console.log(`fetch results (${fetchResults.length}):`);
    for (const [i, r] of fetchResults.entries()) {
      if (r.error) console.log(`  [${i}] ${r.url ?? ''} ERROR=${r.error}`);
      else console.log(`  [${i}] ${r.url ?? ''} media=${r.mediaType ?? ''} bytes=${r.bytes ?? 0}`);
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
