#!/usr/bin/env node
// Generate src/keys.json with random API keys.
//
// Usage:
//   node scripts/gen-keys.js                     # 5 claude + 5 openai (defaults)
//   node scripts/gen-keys.js --claude 10
//   node scripts/gen-keys.js --openai 3
//   node scripts/gen-keys.js --claude 8 --openai 8

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(MODULE_DIR, '..', 'src', 'keys.json');

function parseArgs(argv) {
  const args = { claude: 5, openai: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claude') args.claude = parseInt(argv[++i], 10);
    else if (a === '--openai') args.openai = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/gen-keys.js [--claude N] [--openai N]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function randB64(len) {
  return randomBytes(Math.ceil(len * 3 / 4))
    .toString('base64url')
    .slice(0, len);
}

// sk-ant-api03-<~86 chars>AA
function genClaudeKey() {
  return `sk-ant-api03-${randB64(86)}AA`;
}

// sk-proj-<20>-<20>-<20>T3BlbkFJ<20>-<20>-<20>
function genOpenAIKey() {
  const s = () => randB64(20);
  return `sk-proj-${s()}-${s()}-${s()}T3BlbkFJ${s()}-${s()}-${s()}`;
}

const args = parseArgs(process.argv.slice(2));
const keys = {
  claude: Array.from({ length: args.claude }, genClaudeKey),
  openai: Array.from({ length: args.openai }, genOpenAIKey),
};

writeFileSync(OUT, JSON.stringify(keys, null, 2) + '\n');
console.log(`Generated ${args.claude} claude + ${args.openai} openai keys → src/keys.json`);
