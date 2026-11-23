/**
 * @kip
 * @module bootstrap
 * @layer platform
 * @owner platform-infra
 * @feature K0-003
 * @purpose Translate process environment values into the canonical composition input.
 *
 * Both the local listener and serverless deployment use this module. Keeping the
 * translation in one place prevents authentication credentials or connector
 * settings from drifting between deployment targets.
 */

import { readFileSync } from 'node:fs';
import type { TokenActorMap } from '../api/auth.ts';
import { proxyTokensFromEnv } from '../api/composite-authenticator.ts';
import { loadGitHubAppConfig } from '../github/github-app.ts';
import type { BootstrapEnv } from './composition.ts';

type Environment = Readonly<Record<string, string | undefined>>;

function legacyTokenActorsFromEnv(raw: string | undefined): TokenActorMap {
  const actors = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const [actor, token] = pair.split(':');
    if (actor && token) actors.set(token, actor);
  }
  return actors;
}

function githubEnvironment(environment: Environment): Record<string, string | undefined> {
  const githubEnvironment = { ...environment };
  if (!githubEnvironment.GITHUB_APP_PRIVATE_KEY && githubEnvironment.GITHUB_APP_PRIVATE_KEY_PATH) {
    try {
      githubEnvironment.GITHUB_APP_PRIVATE_KEY = readFileSync(
        githubEnvironment.GITHUB_APP_PRIVATE_KEY_PATH,
        'utf8',
      );
    } catch {
      // An unreadable optional key leaves the connector unconfigured.
    }
  }
  return githubEnvironment;
}

export function bootstrapEnvironment(
  environment: Environment = process.env,
): BootstrapEnv {
  return {
    supabaseUrl: environment.SUPABASE_URL ?? '',
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY ?? '',
    openRouterModel: environment.MODEL_NAME || 'openrouter/auto',
    tokenActors: legacyTokenActorsFromEnv(environment.KIP_API_TOKENS),
    proxyTokens: proxyTokensFromEnv(environment.KIP_PROXY_TOKENS),
    githubApp: loadGitHubAppConfig(githubEnvironment(environment)),
    frontendUrl: environment.KIP_FRONTEND_URL || 'http://localhost:5173',
  };
}
