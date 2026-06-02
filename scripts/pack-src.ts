#!/usr/bin/env bun
// Package the runnable source (src/, index.ts, package.json, tsconfig.json)
// into a zip for distribution. src/keys.json is included.
//
// Usage:
//   bun run scripts/pack-src.ts                      # → dist/src.zip
//   bun run scripts/pack-src.ts --out path/to.zip    # custom output path

import { mkdir, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const MODULE_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(MODULE_DIR, '..');
const DEFAULT_OUT = resolve(ROOT, 'dist', 'src.zip');

const ENTRIES = ['src', 'index.ts', 'package.json', 'tsconfig.json'] as const;
const REQUIRED_FILES = ['src/keys.json', 'index.ts', 'package.json', 'tsconfig.json'] as const;

type Args = { out: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') args.out = resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: bun run scripts/pack-src.ts [--out <zip-path>]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

const args = parseArgs(process.argv.slice(2));

for (const f of REQUIRED_FILES) {
  if (!(await pathExists(resolve(ROOT, f)))) {
    const hint = f === 'src/keys.json' ? ' — run `bun run gen-keys` first' : '';
    console.error(`[pack-src] required file missing: ${f}${hint}`);
    process.exit(1);
  }
}

await mkdir(dirname(args.out), { recursive: true });
await Bun.file(args.out).delete().catch(() => {});

const proc = Bun.spawn(['zip', '-r', '-q', args.out, ...ENTRIES], {
  cwd: ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
});
const code = await proc.exited;
if (code !== 0) {
  console.error(`[pack-src] zip exited with code ${code}`);
  process.exit(code);
}

const size = (await stat(args.out)).size;
const rel = relative(ROOT, args.out);
const display = !rel || rel.startsWith('..') ? args.out : rel;
console.log(`[pack-src] wrote ${display} (${(size / 1024).toFixed(1)} KiB)`);
