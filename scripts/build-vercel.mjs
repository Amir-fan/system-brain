import { build } from 'esbuild';
import { resolve } from 'node:path';

await build({
  entryPoints: [resolve('src/platform/vercel/vercel-entry.ts')],
  outfile: resolve('api/_bundle.mjs'),
  bundle: true,
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  platform: 'node',
  target: 'node22',
});
