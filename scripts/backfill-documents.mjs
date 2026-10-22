// Runs the document backfill through the app's own editor schema, which lives
// in TypeScript, so it is bundled for node first.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const temporary = await mkdtemp(join(tmpdir(), 'still-backfill-'));
try {
  const bundle = join(temporary, 'backfill.mjs');
  await build({ entryPoints: ['scripts/documentBackfill.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22',
    mainFields: ['module', 'main'], outfile: bundle, logLevel: 'warning', external: ['node:sqlite'] });
  const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
