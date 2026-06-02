#!/usr/bin/env bun
// Aggregate usage JSONL logs under ./usage/ and print per-key statistics.
//
// Each log line has shape { ts: <epoch ms>, model: <string|null>, usage: {...} }
// where `usage` is the raw provider usage payload (Anthropic or OpenAI).
//
// Usage:
//   bun run scripts/usage-stats.ts                   # all keys, all months
//   bun run scripts/usage-stats.ts --month 2026-04
//   bun run scripts/usage-stats.ts --key claude-01
//   bun run scripts/usage-stats.ts --by-model
//   bun run scripts/usage-stats.ts --json

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);
const USAGE_DIR = resolve(MODULE_DIR, '..', 'usage');

type Args = { month: string | null; key: string | null; json: boolean; byModel: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { month: null, key: null, json: false, byModel: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--by-model') args.byModel = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: bun run scripts/usage-stats.ts [--month YYYY-MM] [--key <id>] [--by-model] [--json]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

type LogEntry = { keyId: string; month: string; path: string };

function parseLogName(filename: string): { keyId: string; month: string } | null {
  const m = /^(.+)-(\d{4}-\d{2})\.jsonl$/.exec(filename);
  if (!m) return null;
  return { keyId: m[1], month: m[2] };
}

async function listLogs({ keyFilter, monthFilter }: { keyFilter: string | null; monthFilter: string | null }): Promise<LogEntry[]> {
  let files: string[];
  try {
    files = await readdir(USAGE_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const logs: LogEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const parsed = parseLogName(f);
    if (!parsed) continue;
    if (keyFilter && parsed.keyId !== keyFilter) continue;
    if (monthFilter && parsed.month !== monthFilter) continue;
    logs.push({ ...parsed, path: resolve(USAGE_DIR, f) });
  }
  return logs;
}

const SKIP_USAGE_FIELDS = new Set(['cache_creation_input_tokens']);

function addUsage(bucket: Record<string, number>, usage: any, prefix = ''): void {
  if (!usage || typeof usage !== 'object') return;
  for (const [k, v] of Object.entries(usage)) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (SKIP_USAGE_FIELDS.has(name)) continue;
      bucket[name] = (bucket[name] || 0) + v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      addUsage(bucket, v, name);
    }
  }
}

type Bucket = { requests: number; first_ts: number | null; last_ts: number | null; usage: Record<string, number> };

function emptyBucket(): Bucket {
  return { requests: 0, first_ts: null, last_ts: null, usage: {} };
}

type Entry = { ts?: number; model?: string | null; usage?: any };

function applyEntry(bucket: Bucket, entry: Entry): void {
  bucket.requests += 1;
  if (typeof entry.ts === 'number') {
    if (bucket.first_ts == null || entry.ts < bucket.first_ts) bucket.first_ts = entry.ts;
    if (bucket.last_ts == null || entry.ts > bucket.last_ts) bucket.last_ts = entry.ts;
  }
  addUsage(bucket.usage, entry.usage);
}

async function readEntries(path: string): Promise<Entry[]> {
  const text = await readFile(path, 'utf-8');
  const entries: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      console.warn(`[stats] skipping malformed line in ${basename(path)}: ${(err as Error).message}`);
    }
  }
  return entries;
}

const OPENAI_BILLING_USAGE_FIELDS = new Set([
  'input_tokens',
  'input_tokens_details.cached_tokens',
  'output_tokens',
]);

function formatNumber(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  return n.toLocaleString('en-US');
}

function formatBucket(bucket: Bucket, { usageFields = null, withCommas = false }: { usageFields?: Set<string> | null; withCommas?: boolean } = {}): string {
  const fmt = withCommas ? formatNumber : (v: unknown) => v;
  const pairs = Object.entries(bucket.usage)
    .filter(([k]) => !usageFields || usageFields.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${fmt(v)}`);
  return `requests=${fmt(bucket.requests)} ${pairs.join(' ')}`.trimEnd();
}

function claudeFamily(model: string | null | undefined): string | null {
  if (!model || typeof model !== 'string') return null;
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return null;
}

type ClaudePricing = { input: number; output: number; cache5m: number; cache1h: number; cacheRead: number };
const CLAUDE_PRICING: Record<string, ClaudePricing> = {
  'claude-haiku-4.5': { input: 1.0, output: 5.0, cache5m: 1.25, cache1h: 2.0, cacheRead: 0.10 },
  'claude-sonnet-4.6': { input: 3.0, output: 15.0, cache5m: 3.75, cache1h: 6.0, cacheRead: 0.30 },
  'claude-opus-4.6': { input: 5.0, output: 25.0, cache5m: 6.25, cache1h: 10.0, cacheRead: 0.50 },
  'claude-opus-4.6-1m': { input: 5.0, output: 25.0, cache5m: 6.25, cache1h: 10.0, cacheRead: 0.50 },
  'claude-opus-4.7': { input: 5.0, output: 25.0, cache5m: 6.25, cache1h: 10.0, cacheRead: 0.50 },
  'claude-opus-4.7-high': { input: 5.0, output: 25.0, cache5m: 6.25, cache1h: 10.0, cacheRead: 0.50 },
  'claude-opus-4.7-xhigh': { input: 5.0, output: 25.0, cache5m: 6.25, cache1h: 10.0, cacheRead: 0.50 },
  'claude-opus-4.7-1m-internal': { input: 5.0, output: 25.0, cache5m: 6.25, cache1h: 10.0, cacheRead: 0.50 },
  'claude-opus-4.8': { input: 5.0, output: 25.0, cache5m: 6.25, cache1h: 10.0, cacheRead: 0.50 },
};

function computeEntryCost(entry: Entry): number {
  const pricing = entry.model ? CLAUDE_PRICING[entry.model] : undefined;
  if (!pricing) return 0;
  const u = entry.usage || {};
  const inputTokens = u.input_tokens || 0;
  const outputTokens = u.output_tokens || 0;
  const cache5m = u.cache_creation?.ephemeral_5m_input_tokens || 0;
  const cache1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  return (
    inputTokens * pricing.input +
    outputTokens * pricing.output +
    cache5m * pricing.cache5m +
    cache1h * pricing.cache1h +
    cacheRead * pricing.cacheRead
  ) / 1_000_000;
}

type OpenAIPricing = { input: number; cachedInput: number; output: number };
const OPENAI_PRICING: Record<string, OpenAIPricing> = {
  'gpt-5.5': { input: 5.00, cachedInput: 0.50, output: 30.00 },
  'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.00 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.50 },
};

function computeOpenAIEntryCost(entry: Entry): number {
  const pricing = entry.model ? OPENAI_PRICING[entry.model] : undefined;
  if (!pricing) return 0;
  const u = entry.usage || {};
  const inputTokens = u.input_tokens || 0;
  const cachedTokens = Math.min(inputTokens, u.input_tokens_details?.cached_tokens || 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedTokens);
  const outputTokens = u.output_tokens || 0;
  return (
    uncachedInputTokens * pricing.input +
    cachedTokens * pricing.cachedInput +
    outputTokens * pricing.output
  ) / 1_000_000;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logs = await listLogs({ keyFilter: args.key, monthFilter: args.month });
  if (logs.length === 0) {
    console.log(args.json ? '{}' : '(no usage logs found)');
    return;
  }

  const byKey = new Map<string, Map<string, Map<string, Bucket>>>();
  const claudeCostByKeyMonthBucket = new Map<string, Map<string, Map<string, number>>>();
  const openaiCostByKeyMonth = new Map<string, Map<string, number>>();

  for (const log of logs) {
    const entries = await readEntries(log.path);
    const keyMap = byKey.get(log.keyId) || byKey.set(log.keyId, new Map()).get(log.keyId)!;
    const monthMap = keyMap.get(log.month) || keyMap.set(log.month, new Map()).get(log.month)!;
    for (const entry of entries) {
      const family = claudeFamily(entry.model);
      let bk: string;
      if (args.byModel) bk = entry.model || 'unknown';
      else if (family) bk = `(claude-${family})`;
      else bk = '(total)';
      const bucket = monthMap.get(bk) || monthMap.set(bk, emptyBucket()).get(bk)!;
      applyEntry(bucket, entry);
      const cost = computeEntryCost(entry);
      if (cost > 0) {
        const ck = claudeCostByKeyMonthBucket.get(log.keyId)
          || claudeCostByKeyMonthBucket.set(log.keyId, new Map()).get(log.keyId)!;
        const cm = ck.get(log.month) || ck.set(log.month, new Map()).get(log.month)!;
        cm.set(bk, (cm.get(bk) || 0) + cost);
      }
      const openaiCost = computeOpenAIEntryCost(entry);
      if (openaiCost > 0) {
        const ok = openaiCostByKeyMonth.get(log.keyId) || openaiCostByKeyMonth.set(log.keyId, new Map()).get(log.keyId)!;
        ok.set(log.month, (ok.get(log.month) || 0) + openaiCost);
      }
    }
  }

  if (args.json) {
    const out: Record<string, Record<string, any>> = {};
    for (const [keyId, keyMap] of byKey) {
      out[keyId] = {};
      for (const [month, monthMap] of keyMap) {
        const costMap = claudeCostByKeyMonthBucket.get(keyId)?.get(month);
        const openaiCost = openaiCostByKeyMonth.get(keyId)?.get(month) || 0;
        const claudeCosts = costMap ? Object.fromEntries(costMap) : {};
        const totalClaudeCost = Object.values(claudeCosts).reduce((a, b) => a + b, 0);
        out[keyId][month] = {
          ...Object.fromEntries(monthMap),
          _cost_estimate_usd: totalClaudeCost,
          _claude_cost_by_bucket_usd: claudeCosts,
          _openai_cost_estimate_usd: openaiCost,
        };
      }
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  for (const keyId of Array.from(byKey.keys()).sort()) {
    console.log(`\n=== ${keyId} ===`);
    const keyMap = byKey.get(keyId)!;
    for (const month of Array.from(keyMap.keys()).sort()) {
      console.log(`  ${month}`);
      const monthMap = keyMap.get(month)!;
      const openaiCost = openaiCostByKeyMonth.get(keyId)?.get(month) || 0;
      const claudeCostMap = claudeCostByKeyMonthBucket.get(keyId)?.get(month);
      for (const bk of Array.from(monthMap.keys()).sort()) {
        const usageFields = keyId.startsWith('openai-') && bk === '(total)'
          ? OPENAI_BILLING_USAGE_FIELDS
          : null;
        console.log(`    ${bk}: ${formatBucket(monthMap.get(bk)!, { usageFields, withCommas: true })}`);
        const bucketCost = claudeCostMap?.get(bk) || 0;
        if (bucketCost > 0) {
          const label = bk.startsWith('(') && bk.endsWith(')') ? bk.slice(1, -1) : bk;
          console.log(`    estimated cost (${label}): ${formatCost(bucketCost)}`);
        }
        if (bk === '(total)' && openaiCost > 0) {
          console.log(`    estimated cost (openai): ${formatCost(openaiCost)}`);
        }
      }
      if (claudeCostMap && claudeCostMap.size > 1) {
        const total = Array.from(claudeCostMap.values()).reduce((a, b) => a + b, 0);
        console.log(`    estimated cost (claude total): ${formatCost(total)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
