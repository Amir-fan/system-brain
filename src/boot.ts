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

import { readFileSync } from 'node:fs';
import { compose } from './platform/bootstrap/composition.ts';
import { loadGitHubAppConfig } from './platform/github/github-app.ts';
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

/** Reads GitHub App config from env, materialising the PEM from a path when given. */
function githubEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (!env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      env.GITHUB_APP_PRIVATE_KEY = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
    } catch {
      // Unreadable key file: the connector simply stays unconfigured.
    }
  }
  return env;
}

async function main() {
  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? '',
    openRouterModel: process.env.MODEL_NAME || 'openrouter/auto',
    tokenActors: tokenActorsFromEnv(),
    githubApp: loadGitHubAppConfig(githubEnv()),
    frontendUrl: process.env.KIP_FRONTEND_URL || 'http://localhost:5173',
  });
  console.log(
    `KIP github connector: ${process.env.GITHUB_APP_ID && process.env.GITHUB_APP_SLUG ? 'configured' : 'not configured'}`,
  );
  server.listen(ADMIN_PORT, () => {
    console.log(`KIP API listening on :${ADMIN_PORT}`);
  });
}

main().catch((e) => {
  console.error('boot failed', e);
  process.exit(1);
});