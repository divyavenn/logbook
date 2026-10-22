// Runs the document backfill through the app's own editor schema, which lives
// in TypeScript, so it is bundled for node first.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const bundleOf = async outfile => {
  await build({ entryPoints: ['scripts/documentBackfill.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22',
    mainFields: ['module', 'main'], outfile, logLevel: 'warning', external: ['node:sqlite'] });
};

// Built once during the deploy's build, so a boot needs nothing but node.
const emit = process.argv.indexOf('--emit');
if (emit >= 0) {
  const outfile = process.argv[emit + 1];
  if (!outfile) { console.error('Usage: backfill-documents --emit <file>'); process.exit(2); }
  await bundleOf(outfile);
} else {
  const temporary = await mkdtemp(join(tmpdir(), 'still-backfill-'));
  try {
    const bundle = join(temporary, 'backfill.mjs');
    await bundleOf(bundle);
    const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
