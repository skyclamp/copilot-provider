import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const DIST_INDEX_CONTENT = `import app from './src/server.js';

const port = parseInt(process.env.PORT || '4141', 10);

app.listen(port, () => {
  console.log(\`[server] Copilot proxy listening on http://localhost:\${port}\`);
});
`;

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(resolve(ROOT, 'src'), resolve(DIST, 'src'), { recursive: true });
cpSync(resolve(ROOT, 'dist-res', '.token'), resolve(DIST, '.token'));
cpSync(resolve(ROOT, 'dist-res', '.device'), resolve(DIST, '.device'));
writeFileSync(resolve(DIST, 'index.js'), DIST_INDEX_CONTENT);

const srcPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const distDependencies = { ...(srcPkg.dependencies ?? {}) };
delete distDependencies.dotenv;

const distPkg = {
  name: srcPkg.name,
  private: true,
  type: 'module',
  main: 'index.js',
  scripts: {
    start: 'node index.js',
  },
  engines: {
    node: srcPkg.engines?.node || '>=20',
  },
  dependencies: distDependencies,
};

writeFileSync(resolve(DIST, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n');

console.log('✓ JavaScript package ready → dist/');
console.log('');
console.log('Deploy steps:');
console.log('  1. cd dist && npm install --production');
console.log('  2. Deploy dist/ to Azure Web App');
