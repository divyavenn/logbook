import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const temporary = await mkdtemp(join(tmpdir(), 'still-editor-model-'));
try {
  const bundle = join(temporary, 'editor-model.cjs');
  await build({ entryPoints: ['tests/editor-model.ts'], bundle: true, platform: 'node', format: 'cjs',
    mainFields: ['module', 'main'], outfile: bundle, logLevel: 'warning' });
  const result = spawnSync(process.execPath, ['--test', bundle], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
