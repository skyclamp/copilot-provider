/**
 * CAPI support matrix probe for OpenAI Responses API built-in tools.
 *
 * Each probe sends an isolated POST /responses directly to Copilot upstream
 * (see `capi_tests/_lib/capi.ts`) with one OpenAI-style hosted/server tool
 * configuration, then classifies whether CAPI accepted the tool and whether the
 * response emitted the expected Responses output item.
 *
 * Usage:
 *   bun run capi_tests/openai/server-tools/support-matrix.ts
 *   bun run capi_tests/openai/server-tools/support-matrix.ts --model gpt-5.4
 *   bun run capi_tests/openai/server-tools/support-matrix.ts --tool web_search
 *   bun run capi_tests/openai/server-tools/support-matrix.ts --verbose
 */

import { callCapiResponses } from '../../_lib/capi.ts';

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_MCP_SERVER_URL = 'https://dmcp-server.deno.dev/sse';
const DEFAULT_FILE_SEARCH_VECTOR_STORE_ID = 'vs_capi_probe_missing';

type ToolProbe = {
  id: string;
  tool: Record<string, unknown>;
  prompt: string | unknown[];
  expectedOutputTypes: string[];
  bodyExtras?: Record<string, unknown>;
  notes?: string;
};

type OpenAIOutputItem = {
  type?: string;
  name?: string;
  status?: string;
  error?: unknown;
  [key: string]: unknown;
};

type OpenAIResponse = {
  id?: string;
  status?: string;
  output?: OpenAIOutputItem[];
  usage?: Record<string, unknown>;
  error?: { code?: string; message?: string; type?: string };
};

type ErrorResponse = {
  error?: { code?: string; message?: string; type?: string };
  message?: string;
  type?: string;
};

type Verdict = 'supported' | 'maybe' | 'needs_resource' | 'unsupported';

type Outcome = {
  probe: ToolProbe;
  url: string;
  status: number;
  elapsedMs: number;
  verdict: Verdict;
  note: string;
  bodyPreview: string;
};

function parseArgs(argv: string[]): { model: string; only?: string; verbose: boolean } {
  let model = DEFAULT_MODEL;
  let only: string | undefined;
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verbose' || arg === '-v') verbose = true;
    else if (arg === '--model' && argv[i + 1]) {
      model = argv[i + 1];
      i += 1;
    } else if (arg === '--tool' && argv[i + 1]) {
      only = argv[i + 1];
      i += 1;
    }
  }
  return { model, only, verbose };
}

function preview(body: string, max = 360): string {
  const cleaned = body.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractErrorText(body: string): { code: string; message: string; type: string } {
  let parsed: ErrorResponse;
  try {
    parsed = JSON.parse(body) as ErrorResponse;
  } catch {
    return { code: '', message: preview(body, 240), type: '' };
  }
  return {
    code: parsed.error?.code ?? '',
    message: parsed.error?.message ?? parsed.message ?? '',
    type: parsed.error?.type ?? parsed.type ?? '',
  };
}

function classifyError(probe: ToolProbe, status: number, body: string): { verdict: Verdict; note: string } {
  const { code, message, type } = extractErrorText(body);
  const lower = `${code} ${type} ${message}`.toLowerCase();
  if (
    probe.id === 'file_search' &&
    (lower.includes('vector store') || lower.includes('vector_store') || lower.includes('vs_'))
  ) {
    return {
      verdict: 'needs_resource',
      note: `tool accepted far enough to require a real vector store: ${preview(message || code || type, 220)}`,
    };
  }
  return {
    verdict: 'unsupported',
    note: `HTTP ${status} code=${code || '(none)'} type=${type || '(none)'} message=${preview(message, 220)}`,
  };
}

function classifySuccess(probe: ToolProbe, body: string): { verdict: Verdict; note: string } {
  let parsed: OpenAIResponse;
  try {
    parsed = JSON.parse(body) as OpenAIResponse;
  } catch {
    return { verdict: 'maybe', note: 'non-JSON success body' };
  }

  const output = parsed.output ?? [];
  const outputTypes = output.map(item => item.type).filter((type): type is string => typeof type === 'string');
  const matched = probe.expectedOutputTypes.filter(type => outputTypes.includes(type));
  if (matched.length > 0) {
    return {
      verdict: 'supported',
      note: `emitted ${matched.join(', ')} (response status=${parsed.status ?? '?'})`,
    };
  }

  const itemSummary = outputTypes.length ? outputTypes.join(', ') : '(no output items)';
  const responseError = isRecord(parsed.error) ? parsed.error.message : undefined;
  return {
    verdict: 'maybe',
    note: `200 OK, expected ${probe.expectedOutputTypes.join('/')} not seen; output=${itemSummary}${
      responseError ? ` error=${String(responseError)}` : ''
    }`,
  };
}

function buildProbes(): ToolProbe[] {
  const vectorStoreId = Bun.env.CAPI_FILE_SEARCH_VECTOR_STORE_ID || DEFAULT_FILE_SEARCH_VECTOR_STORE_ID;
  const mcpServerUrl = Bun.env.CAPI_MCP_SERVER_URL || DEFAULT_MCP_SERVER_URL;

  return [
    {
      id: 'web_search',
      tool: { type: 'web_search', search_context_size: 'low' },
      prompt: 'Use web_search to find the latest stable Bun release version and date. Reply in one sentence with a citation.',
      expectedOutputTypes: ['web_search_call'],
    },
    {
      id: 'mcp',
      tool: {
        type: 'mcp',
        server_label: 'dmcp',
        server_description: 'A public dice-rolling MCP server used for CAPI probing.',
        server_url: mcpServerUrl,
        require_approval: 'never',
      },
      prompt: 'Use the dmcp MCP server to roll 2d4+1, then report only the resulting integer.',
      expectedOutputTypes: ['mcp_call', 'mcp_list_tools', 'mcp_approval_request'],
      notes: `server_url=${mcpServerUrl}`,
    },
    {
      id: 'shell',
      tool: { type: 'shell', environment: { type: 'container_auto' } },
      prompt: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Use the shell tool to run `printf capi-openai-shell-probe` and report the exact stdout.',
            },
          ],
        },
      ],
      expectedOutputTypes: ['shell_call', 'shell_call_output'],
    },
    {
      id: 'computer',
      tool: { type: 'computer' },
      prompt: 'Use the computer tool to request a screenshot of the current screen. Do not invent screen contents.',
      expectedOutputTypes: ['computer_call'],
    },
    {
      id: 'image_generation',
      tool: { type: 'image_generation', size: '1024x1024', quality: 'low' },
      prompt: 'Generate a simple image of a blue square on a white background.',
      expectedOutputTypes: ['image_generation_call'],
    },
    {
      id: 'file_search',
      tool: { type: 'file_search', vector_store_ids: [vectorStoreId], max_num_results: 1 },
      prompt: 'Use file_search to look for the phrase "capi openai file search probe" and summarise any matching result.',
      expectedOutputTypes: ['file_search_call'],
      bodyExtras: { include: ['file_search_call.results'] },
      notes:
        vectorStoreId === DEFAULT_FILE_SEARCH_VECTOR_STORE_ID
          ? 'set CAPI_FILE_SEARCH_VECTOR_STORE_ID to verify execution against a real vector store'
          : `vector_store_id=${vectorStoreId}`,
    },
    {
      id: 'tool_search',
      tool: { type: 'tool_search' },
      prompt: 'Find the CRM open-orders tool first, then call it for customer CUST-12345.',
      expectedOutputTypes: ['tool_search_call', 'tool_search_output'],
      bodyExtras: {
        parallel_tool_calls: false,
        tools: [
          {
            type: 'namespace',
            name: 'crm',
            description: 'CRM tools for customer lookup and order management.',
            tools: [
              {
                type: 'function',
                name: 'list_open_orders',
                description: 'List open orders for a customer ID.',
                defer_loading: true,
                parameters: {
                  type: 'object',
                  properties: { customer_id: { type: 'string' } },
                  required: ['customer_id'],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

function buildBody(model: string, probe: ToolProbe): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: probe.prompt,
    max_output_tokens: 512,
    tools: [probe.tool],
  };

  if (probe.bodyExtras) {
    for (const [key, value] of Object.entries(probe.bodyExtras)) {
      if (key === 'tools') body.tools = [...(value as Record<string, unknown>[]), probe.tool];
      else body[key] = value;
    }
  }

  return body;
}

async function runProbe(model: string, probe: ToolProbe): Promise<Outcome> {
  const started = performance.now();
  let resp: Response;
  let url = '';
  try {
    const out = await callCapiResponses({ body: buildBody(model, probe) });
    resp = out.resp;
    url = out.url;
  } catch (err) {
    return {
      probe,
      url,
      status: 0,
      elapsedMs: Math.round(performance.now() - started),
      verdict: 'unsupported',
      note: `transport error: ${(err as Error).message}`,
      bodyPreview: '',
    };
  }

  const text = await resp.text();
  const elapsedMs = Math.round(performance.now() - started);
  const classified = resp.ok ? classifySuccess(probe, text) : classifyError(probe, resp.status, text);
  return {
    probe,
    url,
    status: resp.status,
    elapsedMs,
    verdict: classified.verdict,
    note: classified.note,
    bodyPreview: preview(text, 700),
  };
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function printTable(outcomes: Outcome[]): void {
  const cols = {
    tool: Math.max(4, ...outcomes.map(o => o.probe.id.length)),
    status: 6,
    verdict: 14,
  };
  console.log('');
  console.log(`${padRight('TOOL', cols.tool)} | ${padRight('HTTP', cols.status)} | ${padRight('VERDICT', cols.verdict)} | NOTE`);
  console.log(`${'-'.repeat(cols.tool)}-+-${'-'.repeat(cols.status)}-+-${'-'.repeat(cols.verdict)}-+-${'-'.repeat(56)}`);
  for (const outcome of outcomes) {
    console.log(
      `${padRight(outcome.probe.id, cols.tool)} | ${padRight(String(outcome.status), cols.status)} | ${padRight(
        outcome.verdict,
        cols.verdict,
      )} | ${outcome.note}`,
    );
  }
}

async function main(): Promise<void> {
  const { model, only, verbose } = parseArgs(process.argv.slice(2));
  const allProbes = buildProbes();
  const probes = only ? allProbes.filter(probe => probe.id === only) : allProbes;
  if (probes.length === 0) {
    console.error(`unknown --tool ${only ?? ''}; valid ids: ${allProbes.map(probe => probe.id).join(', ')}`);
    process.exit(2);
  }

  console.log(`model=${model}`);
  console.log(`probing ${probes.length} OpenAI Responses API tool${probes.length === 1 ? '' : 's'}`);

  const outcomes: Outcome[] = [];
  for (const probe of probes) {
    console.log(`\n--- ${probe.id} ---`);
    if (probe.notes) console.log(`  note: ${probe.notes}`);
    const outcome = await runProbe(model, probe);
    if (outcome.url && outcomes.length === 0) console.log(`  POST ${outcome.url}`);
    console.log(`  http=${outcome.status} elapsed=${outcome.elapsedMs}ms verdict=${outcome.verdict}`);
    console.log(`  note: ${outcome.note}`);
    if (verbose && outcome.bodyPreview) console.log(`  body: ${outcome.bodyPreview}`);
    outcomes.push(outcome);
  }

  printTable(outcomes);

  const supported = outcomes.filter(outcome => outcome.verdict === 'supported').length;
  const maybe = outcomes.filter(outcome => outcome.verdict === 'maybe').length;
  const needsResource = outcomes.filter(outcome => outcome.verdict === 'needs_resource').length;
  const unsupported = outcomes.filter(outcome => outcome.verdict === 'unsupported').length;
  console.log(`\nsummary: ${supported} supported, ${maybe} maybe, ${needsResource} needs_resource, ${unsupported} unsupported`);
  process.exit(0);
}

main().catch(err => {
  console.error('probe failed:', err);
  process.exit(1);
});
