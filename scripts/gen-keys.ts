#!/usr/bin/env bun
// Generate src/keys.json with random API keys.
//
// Usage:
//   bun run scripts/gen-keys.ts                     # 5 claude + 5 openai (defaults)
//   bun run scripts/gen-keys.ts --claude 10
//   bun run scripts/gen-keys.ts --openai 3
//   bun run scripts/gen-keys.ts --claude 8 --openai 8

import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);
const OUT = resolve(MODULE_DIR, '..', 'src', 'keys.json');

type Args = { claude: number; openai: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { claude: 5, openai: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claude') args.claude = parseInt(argv[++i], 10);
    else if (a === '--openai') args.openai = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: bun run scripts/gen-keys.ts [--claude N] [--openai N]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function randB64(len: number): string {
  return randomBytes(Math.ceil((len * 3) / 4))
    .toString('base64url')
    .slice(0, len);
}

function genClaudeKey(): string {
  return `sk-ant-api03-${randB64(86)}AA`;
}

function genOpenAIKey(): string {
  const s = () => randB64(20);
  return `sk-proj-${s()}-${s()}-${s()}T3BlbkFJ${s()}-${s()}-${s()}`;
}

const args = parseArgs(process.argv.slice(2));
const keys = {
  claude: Array.from({ length: args.claude }, genClaudeKey),
  openai: Array.from({ length: args.openai }, genOpenAIKey),
};

await Bun.write(OUT, JSON.stringify(keys, null, 2) + '\n');
console.log(`Generated ${args.claude} claude + ${args.openai} openai keys → src/keys.json`);
