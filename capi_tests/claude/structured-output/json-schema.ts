/**
 * CAPI probe for Anthropic JSON structured outputs (`output_config.format`).
 *
 * Sends an Anthropic-shaped structured-output request directly to Copilot's
 * upstream /v1/messages (no local proxy involved — see
 * `capi_tests/_lib/capi.ts`) so we can learn whether CAPI honours
 * `output_config.format` natively for a given Claude model, or whether it
 * ignores / rejects the parameter (which is why the proxy currently rewrites
 * structured-output requests onto /chat/completions).
 *
 * The probe checks three things:
 *   1. CAPI returns 2xx.
 *   2. The single text content block parses as JSON.
 *   3. That JSON validates against the requested schema's required keys.
 *
 * Exits 0 only when CAPI returns 2xx AND the response is schema-valid JSON.
 * Any non-2xx, non-JSON, or schema-mismatch is treated as "structured output
 * not supported by CAPI" and the script exits non-zero with the raw payload.
 *
 * Usage:
 *   bun run capi_tests/claude/structured-output/json-schema.ts                 # non-streaming
 *   bun run capi_tests/claude/structured-output/json-schema.ts --stream        # SSE
 *   bun run capi_tests/claude/structured-output/json-schema.ts --model claude-opus-4.7
 *
 * Anthropic docs:
 *   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */

import { callCapiMessages } from '../../_lib/capi.ts';

const DEFAULT_MODEL = 'claude-opus-4.8';
const PROMPT =
  'Extract the key information from this email: John Smith (john@example.com) is ' +
  'interested in our Enterprise plan and wants to schedule a demo for next Tuesday at 2pm.';

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string' },
    plan_interest: { type: 'string' },
    demo_requested: { type: 'boolean' },
  },
  required: ['name', 'email', 'plan_interest', 'demo_requested'],
  additionalProperties: false,
} as const;

type ClaudeContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type ClaudeMessageResponse = {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: ClaudeContentBlock[];
  usage?: Record<string, unknown>;
};

function parseArgs(argv: string[]): { stream: boolean; model: string } {
  const stream = argv.includes('--stream');
  const modelIdx = argv.indexOf('--model');
  const model = modelIdx >= 0 && argv[modelIdx + 1] ? argv[modelIdx + 1] : DEFAULT_MODEL;
  return { stream, model };
}

function buildBody(model: string, stream: boolean): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    stream,
    messages: [{ role: 'user', content: PROMPT }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: SCHEMA,
      },
    },
  };
}

/** Returns the missing required keys (empty array = schema-valid). */
function validateAgainstSchema(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [...SCHEMA.required];
  }
  const obj = value as Record<string, unknown>;
  return SCHEMA.required.filter(key => !(key in obj));
}

function reportJson(rawText: string): boolean {
  console.log(`structured text: ${rawText}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    console.error(`NOT supported: response text is not valid JSON (${String(err)})`);
    return false;
  }
  const missing = validateAgainstSchema(parsed);
  if (missing.length > 0) {
    console.error(`NOT supported: JSON missing required keys: ${missing.join(', ')}`);
    return false;
  }
  console.log('SUPPORTED: response is valid JSON matching the requested schema.');
  return true;
}

async function runNonStreaming(model: string): Promise<void> {
  const started = performance.now();
  const { resp, url } = await callCapiMessages({ body: buildBody(model, false) });
  const elapsedMs = Math.round(performance.now() - started);
  const text = await resp.text();
  console.log(`POST ${url}`);
  console.log(`status=${resp.status} elapsed=${elapsedMs}ms`);

  if (!resp.ok) {
    console.error('NOT supported: upstream returned non-2xx. Body:');
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
  const textBlock = parsed.content?.find(b => b.type === 'text' && typeof b.text === 'string');
  if (!textBlock?.text) {
    console.error('NOT supported: no text content block in response.');
    console.error(JSON.stringify(parsed.content, null, 2));
    process.exit(1);
  }

  const ok = reportJson(textBlock.text);
  if (parsed.usage) console.log(`usage=${JSON.stringify(parsed.usage)}`);
  process.exit(ok ? 0 : 1);
}

async function runStreaming(model: string): Promise<void> {
  const started = performance.now();
  const { resp, url } = await callCapiMessages({ body: buildBody(model, true), stream: true });
  console.log(`POST ${url}`);
  console.log(`status=${resp.status}`);

  if (!resp.ok || !resp.body) {
    const errText = await resp.text();
    console.error('NOT supported: upstream returned non-2xx. Body:');
    console.error(errText);
    process.exit(1);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventCount = 0;
  const seenEventTypes = new Set<string>();
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

      if (eventType === 'content_block_delta') {
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
  const ok = reportJson(textOut);
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  const { stream, model } = parseArgs(process.argv.slice(2));
  console.log(`model=${model} feature=output_config.format(json_schema) stream=${stream}`);
  console.log(`prompt: ${PROMPT}`);
  console.log('---');
  if (stream) await runStreaming(model);
  else await runNonStreaming(model);
}

main().catch(err => {
  console.error('probe failed:', err);
  process.exit(1);
});
