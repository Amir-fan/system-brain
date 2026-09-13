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
import type { TokenActorMap } from './platform/api/auth.ts';

const ADMIN_PORT = Number(process.env.KIP_PORT ?? 8787);

function tokenActorsFromEnv(): TokenActorMap {
  const map = new Map<string, string>();
  const raw = process.env.KIP_API_TOKENS; // "actor:token" comma-separated
  for (const pair of (raw ?? '').split(',')) {
    const [actor, token] = pair.split(':');
    if (actor && token) map.set(token, actor);
  }
  return map;
}

async function main() {
  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? '',
    openRouterModel: process.env.MODEL_NAME || 'openrouter/auto',
    tokenActors: tokenActorsFromEnv(),
  });
  server.listen(ADMIN_PORT, () => {
    console.log(`KIP API listening on :${ADMIN_PORT}`);
  });
}

main().catch((e) => {
  console.error('boot failed', e);
  process.exit(1);
});