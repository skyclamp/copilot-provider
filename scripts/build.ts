import { resolve } from 'node:path';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dir, '..');
const DIST = resolve(ROOT, 'dist');

// Clean
rmSync(DIST, { recursive: true, force: true });

// Compile TypeScript → Node.js CommonJS
console.log('Compiling TypeScript...');
execSync('./node_modules/.bin/tsc -p tsconfig.build.json', { stdio: 'inherit', cwd: ROOT });

// Generate production package.json
const srcPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const distPkg = {
  name: srcPkg.name,
  private: true,
  scripts: {
    start: 'node index.js',
  },
  engines: {
    node: '>=24',
  },
  dependencies: {
    express: srcPkg.dependencies.express,
  },
};

writeFileSync(resolve(DIST, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');

console.log('✓ Build complete → dist/');
console.log('');
console.log('Deploy steps:');
console.log('  1. cd dist && npm install --production');
console.log('  2. Deploy dist/ to Azure Web App');
