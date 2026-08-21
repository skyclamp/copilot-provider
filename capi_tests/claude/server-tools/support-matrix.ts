/**
 * CAPI support matrix probe for a batch of Anthropic-defined tools.
 *
 * For each entry below this script sends an isolated POST /v1/messages
 * directly to the Copilot upstream (see `capi_tests/_lib/capi.ts`) with that one
 * tool declared, captures the upstream response, and classifies it:
 *
 *   supported=yes   2xx + model emits the expected tool_use / server_tool_use
 *   supported=maybe 2xx but the model chose not to invoke the tool
 *                   (CAPI accepted the declaration; we can't tell more without
 *                    a forcing prompt — the tool is at least not blocklisted)
 *   supported=no    non-2xx, CAPI explicitly rejected the tool / shape / beta
 *
 * The matrix targets `claude-opus-4.7` and sends the beta header Anthropic
 * documents for each tool. It does NOT use the local proxy — beta whitelists
 * and model aliasing in `src/` are irrelevant here.
 *
 * Usage:
 *   bun run capi_tests/claude/server-tools/support-matrix.ts
 *   bun run capi_tests/claude/server-tools/support-matrix.ts --tool code_execution_20260120
 *   bun run capi_tests/claude/server-tools/support-matrix.ts --verbose
 */

import { callCapiMessages } from '../../_lib/capi.ts';

const MODEL = 'claude-opus-4.7';

type ToolProbe = {
  /** Identifier shown in the report; same as the tool `type`. */
  id: string;
  /** Tool object dropped verbatim into `tools[0]`. */
  tool: Record<string, unknown>;
  /** Optional `anthropic-beta` header value documented for this tool. */
  beta?: string;
  /** Prompt designed to coax the model into actually invoking the tool. */
  prompt: string;
};

const PROBES: ToolProbe[] = [
  {
    id: 'web_search_20260209',
    tool: { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
    // No documented Anthropic beta header for the dynamic-filtering web_search.
    prompt:
      'Search the web for the latest stable Bun release version and date, then summarise with a citation.',
  },
  {
    id: 'web_fetch_20260209',
    tool: { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1 },
    prompt: 'Fetch https://bun.sh and summarise the first paragraph in one sentence.',
  },
  {
    id: 'code_execution_20260120',
    tool: { type: 'code_execution_20260120', name: 'code_execution' },
    // Copilot accepts `code-execution-2026-01-20` as a beta but the older
    // `2025-08-25` beta is itself rejected by CAPI ("unsupported beta
    // header(s)"). Use the matching-date beta so the verdict reflects
    // tool-level support, not beta-header gating.
    beta: 'code-execution-2026-01-20',
    prompt: 'Use the code_execution tool to compute (47 * 53) + 8 and reply with just the integer.',
  },
  {
    id: 'advisor_20260301',
    tool: { type: 'advisor_20260301', name: 'advisor' },
    // Anthropic has not publicly documented an `advisor` tool; the beta header
    // (if any) is a best-effort guess based on the date-versioned naming.
    beta: 'advisor-2026-03-01',
    prompt: 'Use the advisor tool to get one short tip on writing idiomatic TypeScript.',
  },
  {
    id: 'memory_20250818',
    tool: { type: 'memory_20250818', name: 'memory' },
    beta: 'context-management-2025-06-27',
    prompt: 'Remember that my favourite colour is teal. Use the memory tool to store this.',
  },
  {
    id: 'bash_20250124',
    tool: { type: 'bash_20250124', name: 'bash' },
    beta: 'computer-use-2025-11-24',
    prompt: 'Use the bash tool to run `echo hello` and report what the command prints.',
  },
  {
    id: 'computer_20251124',
    tool: {
      type: 'computer_20251124',
      name: 'computer',
      display_width_px: 1024,
      display_height_px: 768,
      display_number: 1,
    },
    beta: 'computer-use-2025-11-24',
    prompt: 'Use the computer tool to take a screenshot of the current screen.',
  },
  {
    id: 'text_editor_20250728',
    tool: { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
    beta: 'computer-use-2025-11-24',
    prompt: 'Use the str_replace_based_edit_tool to create a file foo.txt containing the text "hello".',
  },
];

type ClaudeBlock = { type: string; name?: string; [key: string]: unknown };
type SuccessResponse = {
  model?: string;
  stop_reason?: string | null;
  content?: ClaudeBlock[];
};
type ErrorResponse = {
  error?: { type?: string; code?: string; message?: string };
};

type Verdict = 'supported' | 'maybe' | 'unsupported';

type Outcome = {
  probe: ToolProbe;
  status: number;
  elapsedMs: number;
  verdict: Verdict;
  note: string;
  bodyPreview: string;
};

function parseArgs(argv: string[]): { only?: string; verbose: boolean } {
  let only: string | undefined;
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--tool' && argv[i + 1]) {
      only = argv[i + 1];
      i += 1;
    }
  }
  return { only, verbose };
}

function preview(body: string, max = 320): string {
  const cleaned = body.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

function classifyError(status: number, body: string): { verdict: Verdict; note: string } {
  let parsed: ErrorResponse & { message?: string };
  try {
    parsed = JSON.parse(body) as ErrorResponse & { message?: string };
  } catch {
    return { verdict: 'unsupported', note: `HTTP ${status} (non-JSON)` };
  }
  // CAPI returns at least two error shapes: `{error: {code, message}}` and
  // `{message}` at the root. Try both.
  const code = parsed.error?.code ?? '';
  const message = parsed.error?.message ?? parsed.message ?? '';
  return {
    verdict: 'unsupported',
    note: `code=${code || '(none)'} message=${preview(message, 200)}`,
  };
}

function classifySuccess(probe: ToolProbe, body: string): { verdict: Verdict; note: string } {
  let parsed: SuccessResponse;
  try {
    parsed = JSON.parse(body) as SuccessResponse;
  } catch {
    return { verdict: 'maybe', note: 'non-JSON success body' };
  }
  const blocks = parsed.content ?? [];
  const toolName = probe.tool.name as string | undefined;
  const invokedAsClient = blocks.some(b => b.type === 'tool_use' && b.name === toolName);
  const invokedAsServer = blocks.some(b => b.type === 'server_tool_use' && b.name === toolName);
  const resultBlockType = `${toolName ?? ''}_tool_result`;
  const resultBlock = blocks.some(b => b.type === resultBlockType);
  if (invokedAsServer && resultBlock) {
    return { verdict: 'supported', note: `server_tool_use + ${resultBlockType} emitted` };
  }
  if (invokedAsServer) return { verdict: 'supported', note: 'server_tool_use emitted' };
  if (invokedAsClient) return { verdict: 'supported', note: `tool_use(name=${toolName}) emitted` };
  return {
    verdict: 'maybe',
    note: `200 OK, model did not invoke the tool (stop_reason=${parsed.stop_reason ?? '?'})`,
  };
}

async function runProbe(probe: ToolProbe): Promise<Outcome> {
  const body = {
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: probe.prompt }],
    tools: [probe.tool],
  };
  const extraHeaders: Record<string, string> = {};
  if (probe.beta) extraHeaders['anthropic-beta'] = probe.beta;

  const started = performance.now();
  let resp: Response;
  let url = '';
  try {
    const out = await callCapiMessages({ body, extraHeaders });
    resp = out.resp;
    url = out.url;
  } catch (err) {
    return {
      probe,
      status: 0,
      elapsedMs: Math.round(performance.now() - started),
      verdict: 'unsupported',
      note: `transport error: ${(err as Error).message}`,
      bodyPreview: '',
    };
  }
  const text = await resp.text();
  const elapsedMs = Math.round(performance.now() - started);
  const classified = resp.ok ? classifySuccess(probe, text) : classifyError(resp.status, text);
  void url;
  return {
    probe,
    status: resp.status,
    elapsedMs,
    verdict: classified.verdict,
    note: classified.note,
    bodyPreview: preview(text, 500),
  };
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function printTable(outcomes: Outcome[]): void {
  const cols = {
    tool: Math.max(4, ...outcomes.map(o => o.probe.id.length)),
    status: 6,
    verdict: 11,
  };
  console.log('');
  console.log(`${padRight('TOOL', cols.tool)} | ${padRight('HTTP', cols.status)} | ${padRight('VERDICT', cols.verdict)} | NOTE`);
  console.log(`${'-'.repeat(cols.tool)}-+-${'-'.repeat(cols.status)}-+-${'-'.repeat(cols.verdict)}-+-${'-'.repeat(48)}`);
  for (const o of outcomes) {
    console.log(`${padRight(o.probe.id, cols.tool)} | ${padRight(String(o.status), cols.status)} | ${padRight(o.verdict, cols.verdict)} | ${o.note}`);
  }
}

async function main(): Promise<void> {
  const { only, verbose } = parseArgs(process.argv.slice(2));
  const probes = only ? PROBES.filter(p => p.id === only) : PROBES;
  if (probes.length === 0) {
    console.error(`unknown --tool ${only ?? ''}; valid ids: ${PROBES.map(p => p.id).join(', ')}`);
    process.exit(2);
  }

  console.log(`model=${MODEL}`);
  console.log(`probing ${probes.length} tool${probes.length === 1 ? '' : 's'} (anthropic-beta sent per Anthropic docs)`);

  const outcomes: Outcome[] = [];
  for (const probe of probes) {
    console.log(`\n--- ${probe.id} (beta=${probe.beta ?? '(none)'}) ---`);
    const outcome = await runProbe(probe);
    console.log(`  http=${outcome.status} elapsed=${outcome.elapsedMs}ms verdict=${outcome.verdict}`);
    console.log(`  note: ${outcome.note}`);
    if (verbose && outcome.bodyPreview) console.log(`  body: ${outcome.bodyPreview}`);
    outcomes.push(outcome);
  }

  printTable(outcomes);

  const supported = outcomes.filter(o => o.verdict === 'supported').length;
  const maybe = outcomes.filter(o => o.verdict === 'maybe').length;
  const unsupported = outcomes.filter(o => o.verdict === 'unsupported').length;
  console.log(`\nsummary: ${supported} supported, ${maybe} maybe, ${unsupported} unsupported`);
  process.exit(0);
}

main().catch(err => {
  console.error('probe failed:', err);
  process.exit(1);
});
