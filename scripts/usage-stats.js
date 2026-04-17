#!/usr/bin/env node
// Aggregate usage JSONL logs under ./usage/ and print per-key statistics.
//
// Each log line has shape { ts: <epoch ms>, model: <string|null>, usage: {...} }
// where `usage` is the raw provider usage payload (Anthropic or OpenAI).
//
// Usage:
//   node scripts/usage-stats.js                   # all keys, all months
//   node scripts/usage-stats.js --month 2026-04
//   node scripts/usage-stats.js --key claude-01
//   node scripts/usage-stats.js --by-model
//   node scripts/usage-stats.js --json

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const USAGE_DIR = resolve(MODULE_DIR, '..', 'usage');

function parseArgs(argv) {
  const args = { month: null, key: null, json: false, byModel: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--by-model') args.byModel = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/usage-stats.js [--month YYYY-MM] [--key <id>] [--by-model] [--json]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// Parse "claude-01-2026-04.jsonl" -> { keyId, month }
function parseLogName(filename) {
  const m = /^(.+)-(\d{4}-\d{2})\.jsonl$/.exec(filename);
  if (!m) return null;
  return { keyId: m[1], month: m[2] };
}

async function listLogs({ keyFilter, monthFilter }) {
  let files;
  try {
    files = await readdir(USAGE_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const logs = [];
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

// Top-level fields that duplicate nested breakdowns and are not used for billing.
const SKIP_USAGE_FIELDS = new Set(['cache_creation_input_tokens']);

// Flatten nested usage objects to dotted field names while summing numbers.
function addUsage(bucket, usage, prefix = '') {
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

function emptyBucket() {
  return { requests: 0, first_ts: null, last_ts: null, usage: {} };
}

function applyEntry(bucket, entry) {
  bucket.requests += 1;
  if (typeof entry.ts === 'number') {
    if (bucket.first_ts == null || entry.ts < bucket.first_ts) bucket.first_ts = entry.ts;
    if (bucket.last_ts == null || entry.ts > bucket.last_ts) bucket.last_ts = entry.ts;
  }
  addUsage(bucket.usage, entry.usage);
}

async function readEntries(path) {
  const text = await readFile(path, 'utf-8');
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      console.warn(`[stats] skipping malformed line in ${basename(path)}: ${err.message}`);
    }
  }
  return entries;
}

const OPENAI_BILLING_USAGE_FIELDS = new Set([
  'input_tokens',
  'input_tokens_details.cached_tokens',
  'output_tokens',
]);

function formatBucket(bucket, usageFields = null) {
  const pairs = Object.entries(bucket.usage)
    .filter(([k]) => !usageFields || usageFields.has(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return `requests=${bucket.requests} ${pairs.join(' ')}`.trimEnd();
}

// Pricing per million tokens (USD) for supported Claude models.
const CLAUDE_PRICING = {
  'claude-haiku-4-5':  { input: 1,   output: 5,   cache5m: 1.25, cache1h: 2,   cacheRead: 0.10 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cache5m: 3.75, cache1h: 6,   cacheRead: 0.30 },
  'claude-opus-4-6':   { input: 5,   output: 25,  cache5m: 6.25, cache1h: 10,  cacheRead: 0.50 },
  'claude-opus-4-7':   { input: 5,   output: 25,  cache5m: 6.25, cache1h: 10,  cacheRead: 0.50 },
};

function computeEntryCost(entry) {
  const pricing = CLAUDE_PRICING[entry.model];
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

// Pricing per million tokens (USD) for supported OpenAI models.
const OPENAI_PRICING = {
  'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14.00 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.50 },
};

function computeOpenAIEntryCost(entry) {
  const pricing = OPENAI_PRICING[entry.model];
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

function formatCost(cost) {
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logs = await listLogs({ keyFilter: args.key, monthFilter: args.month });
  if (logs.length === 0) {
    console.log(args.json ? '{}' : '(no usage logs found)');
    return;
  }

  // byKey: Map<keyId, Map<month, Map<bucketKey, bucket>>>
  const byKey = new Map();
  // costByKeyMonth: Map<keyId, Map<month, number>>
  const costByKeyMonth = new Map();
  // openaiCostByKeyMonth: Map<keyId, Map<month, number>>
  const openaiCostByKeyMonth = new Map();
  for (const log of logs) {
    const entries = await readEntries(log.path);
    const keyMap = byKey.get(log.keyId) || byKey.set(log.keyId, new Map()).get(log.keyId);
    const monthMap = keyMap.get(log.month) || keyMap.set(log.month, new Map()).get(log.month);
    for (const entry of entries) {
      const bk = args.byModel ? (entry.model || 'unknown') : '(total)';
      const bucket = monthMap.get(bk) || monthMap.set(bk, emptyBucket()).get(bk);
      applyEntry(bucket, entry);
      const cost = computeEntryCost(entry);
      if (cost > 0) {
        const ck = costByKeyMonth.get(log.keyId) || costByKeyMonth.set(log.keyId, new Map()).get(log.keyId);
        ck.set(log.month, (ck.get(log.month) || 0) + cost);
      }
      const openaiCost = computeOpenAIEntryCost(entry);
      if (openaiCost > 0) {
        const ok = openaiCostByKeyMonth.get(log.keyId) || openaiCostByKeyMonth.set(log.keyId, new Map()).get(log.keyId);
        ok.set(log.month, (ok.get(log.month) || 0) + openaiCost);
      }
    }
  }

  if (args.json) {
    const out = {};
    for (const [keyId, keyMap] of byKey) {
      out[keyId] = {};
      for (const [month, monthMap] of keyMap) {
        const cost = costByKeyMonth.get(keyId)?.get(month) || 0;
        const openaiCost = openaiCostByKeyMonth.get(keyId)?.get(month) || 0;
        out[keyId][month] = {
          ...Object.fromEntries(monthMap),
          _cost_estimate_usd: cost,
          _openai_cost_estimate_usd: openaiCost,
        };
      }
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  for (const keyId of Array.from(byKey.keys()).sort()) {
    console.log(`\n=== ${keyId} ===`);
    const keyMap = byKey.get(keyId);
    for (const month of Array.from(keyMap.keys()).sort()) {
      console.log(`  ${month}`);
      const monthMap = keyMap.get(month);
      const openaiCost = openaiCostByKeyMonth.get(keyId)?.get(month) || 0;
      for (const bk of Array.from(monthMap.keys()).sort()) {
        const usageFields = keyId.startsWith('openai-') && bk === '(total)'
          ? OPENAI_BILLING_USAGE_FIELDS
          : null;
        console.log(`    ${bk}: ${formatBucket(monthMap.get(bk), usageFields)}`);
        if (bk === '(total)' && openaiCost > 0) {
          console.log(`    estimated cost (openai): ${formatCost(openaiCost)}`);
        }
      }
      const cost = costByKeyMonth.get(keyId)?.get(month) || 0;
      if (cost > 0) {
        console.log(`    estimated cost (claude): ${formatCost(cost)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
