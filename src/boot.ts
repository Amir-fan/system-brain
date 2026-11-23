/**
 * @kip
 * @module app
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Minimal local server bootstrap: reads env and composes KIP.
 *
 * Intentionally tiny — config/env concerns live in the composition root.
 * Not a deploy target by itself; exists for local verification.
 */

import { compose } from './platform/bootstrap/composition.ts';
import { bootstrapEnvironment } from './platform/bootstrap/environment.ts';

const ADMIN_PORT = Number(process.env.KIP_PORT ?? 8787);

async function main() {
  const environment = bootstrapEnvironment();
  const server = await compose(environment);
  console.log(
    `KIP github connector: ${environment.githubApp ? 'configured' : 'not configured'}`,
  );
  server.listen(ADMIN_PORT, () => {
    console.log(`KIP API listening on :${ADMIN_PORT}`);
  });
}

main().catch((e) => {
  console.error('boot failed', e);
  process.exit(1);
});
