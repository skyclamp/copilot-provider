/**
 * CAPI support matrix for Anthropic `anthropic-beta` headers.
 *
 * For each (model × beta-header) pair this script sends an isolated, minimal
 * POST /v1/messages directly to the Copilot upstream (see
 * `capi_tests/_lib/capi.ts`) carrying just that one beta header, and records
 * whether CAPI accepts or rejects the header. The body is a trivial "ping"
 * (max_tokens=1, no tools) so the only thing under test is the beta-header gate
 * — not the feature behind it.
 *
 * Copilot's CAPI maintains its **own** allow-list of beta headers, independent
 * of the proxy's `ANTHROPIC_BETA_PREFIX_WHITELIST` in `src/messages.ts`. This
 * probe bypasses the proxy entirely, so it reports what the upstream actually
 * admits per model.
 *
 * Classification per cell:
 *   ok    HTTP 200 — CAPI accepted the beta header for this model
 *   no    HTTP 4xx whose error message references a beta header — rejected at
 *         the beta gate
 *   e<n>  HTTP n for some other reason (header likely accepted, request failed
 *         downstream) — see --verbose for the message
 *
 * The beta-header list is sourced from the official Anthropic TypeScript SDK
 * `AnthropicBeta` union, plus a few newer date-versions referenced elsewhere in
 * this repo (`src/messages.ts` whitelist, the server-tools matrix).
 *   https://github.com/anthropics/anthropic-sdk-typescript (resources/beta/beta.ts)
 *
 * Usage:
 *   bun run capi_tests/claude/beta-headers/support-matrix.ts
 *   bun run capi_tests/claude/beta-headers/support-matrix.ts --model claude-opus-4.8
 *   bun run capi_tests/claude/beta-headers/support-matrix.ts --beta files-api-2025-04-14
 *   bun run capi_tests/claude/beta-headers/support-matrix.ts --verbose
 */

import { callCapiMessages } from '../../_lib/capi.ts';

const MODELS = [
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
];

// Official AnthropicBeta union (anthropic-sdk-typescript) + a few newer
// date-versions referenced elsewhere in this repo.
const BETAS = [
  'message-batches-2024-09-24',
  'prompt-caching-2024-07-31',
  'computer-use-2024-10-22',
  'computer-use-2025-01-24',
  'computer-use-2025-11-24',
  'pdfs-2024-09-25',
  'token-counting-2024-11-01',
  'token-efficient-tools-2025-02-19',
  'output-128k-2025-02-19',
  'files-api-2025-04-14',
  'mcp-client-2025-04-04',
  'mcp-client-2025-11-20',
  'dev-full-thinking-2025-05-14',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'code-execution-2025-05-22',
  'code-execution-2026-01-20',
  'extended-cache-ttl-2025-04-11',
  'context-1m-2025-08-07',
  'context-management-2025-06-27',
  'model-context-window-exceeded-2025-08-26',
  'skills-2025-10-02',
  'fast-mode-2026-02-01',
  'output-300k-2026-03-24',
  'user-profiles-2026-03-24',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'structured-outputs-2025-11-13',
  'managed-agents-2026-04-01',
  'cache-diagnosis-2026-04-07',
  'thinking-token-count-2026-05-13',
];

type Verdict = 'ok' | 'no' | 'error';

type Cell = {
  status: number;
  verdict: Verdict;
  message: string;
};

type ErrorBody = {
  error?: { type?: string; code?: string; message?: string };
  message?: string;
};

function parseArgs(argv: string[]): { model?: string; beta?: string; verbose: boolean } {
  let model: string | undefined;
  let beta: string | undefined;
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--model' && argv[i + 1]) {
      model = argv[i + 1];
      i += 1;
    } else if (a === '--beta' && argv[i + 1]) {
      beta = argv[i + 1];
      i += 1;
    }
  }
  return { model, beta, verbose };
}

function preview(body: string, max = 200): string {
  const cleaned = body.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as ErrorBody;
    return parsed.error?.message ?? parsed.message ?? preview(body);
  } catch {
    return preview(body);
  }
}

/** A 4xx whose message references a beta header = rejected at the beta gate. */
function isBetaRejection(message: string): boolean {
  return /beta\s*header/i.test(message) || /unsupported beta/i.test(message);
}

async function probeCell(model: string, beta: string): Promise<Cell> {
  const body = {
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };
  let resp: Response;
  try {
    const out = await callCapiMessages({ body, extraHeaders: { 'anthropic-beta': beta } });
    resp = out.resp;
  } catch (err) {
    return { status: 0, verdict: 'error', message: `transport: ${(err as Error).message}` };
  }
  const text = await resp.text();
  if (resp.ok) return { status: resp.status, verdict: 'ok', message: '' };
  const message = errorMessage(text);
  return {
    status: resp.status,
    verdict: isBetaRejection(message) ? 'no' : 'error',
    message,
  };
}

function cellLabel(cell: Cell): string {
  if (cell.verdict === 'ok') return 'ok';
  if (cell.verdict === 'no') return 'no';
  return `e${cell.status}`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** Short column header for a model id, e.g. claude-opus-4.8 -> opus-4.8. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

function printGrid(models: string[], betas: string[], grid: Map<string, Cell>): void {
  const betaCol = Math.max(4, ...betas.map(b => b.length));
  const modelCols = models.map(m => Math.max(6, shortModel(m).length));

  let header = padRight('BETA HEADER', betaCol);
  models.forEach((m, i) => {
    header += ' | ' + padRight(shortModel(m), modelCols[i]);
  });
  console.log('');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const beta of betas) {
    let row = padRight(beta, betaCol);
    models.forEach((m, i) => {
      const cell = grid.get(`${m}\u0000${beta}`);
      row += ' | ' + padRight(cell ? cellLabel(cell) : '?', modelCols[i]);
    });
    console.log(row);
  }
  console.log('');
  console.log('legend: ok = accepted (200), no = rejected at beta gate, e<n> = other HTTP n');
}

async function main(): Promise<void> {
  const { model, beta, verbose } = parseArgs(process.argv.slice(2));
  const models = model ? MODELS.filter(m => m === model) : MODELS;
  const betas = beta ? BETAS.filter(b => b === beta) : BETAS;

  if (models.length === 0) {
    console.error(`unknown --model ${model ?? ''}; valid: ${MODELS.join(', ')}`);
    process.exit(2);
  }
  if (betas.length === 0) {
    console.error(`unknown --beta ${beta ?? ''}; valid: ${BETAS.join(', ')}`);
    process.exit(2);
  }

  console.log(`probing ${betas.length} beta header(s) × ${models.length} model(s) = ${betas.length * models.length} requests`);
  console.log(`models: ${models.join(', ')}`);

  const grid = new Map<string, Cell>();
  for (const b of betas) {
    const parts: string[] = [];
    for (const m of models) {
      const cell = await probeCell(m, b);
      grid.set(`${m}\u0000${b}`, cell);
      parts.push(`${shortModel(m)}=${cellLabel(cell)}`);
      if (verbose && cell.message) {
        console.log(`  [${b} / ${m}] ${cell.status}: ${preview(cell.message)}`);
      }
    }
    console.log(`${padRight(b, 42)} ${parts.join('  ')}`);
  }

  printGrid(models, betas, grid);

  let ok = 0;
  let no = 0;
  let err = 0;
  for (const cell of grid.values()) {
    if (cell.verdict === 'ok') ok += 1;
    else if (cell.verdict === 'no') no += 1;
    else err += 1;
  }
  console.log(`summary: ${ok} accepted, ${no} rejected, ${err} other (across all cells)`);
  process.exit(0);
}

main().catch(err => {
  console.error('probe failed:', err);
  process.exit(1);
});
