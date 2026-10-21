// Bundles tests/*.test.ts with esbuild (bundled with Vite) and runs them with Node's built-in test runner.
// Usage: npm test
import { build } from 'esbuild';
import { readdirSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts'));
mkdirSync('.test-build', { recursive: true });
await build({ entryPoints: files.map((f) => join('tests', f)), outdir: '.test-build', bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, logLevel: 'warning' });
const r = spawnSync(process.execPath, ['--test', ...files.map((f) => join('.test-build', f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
