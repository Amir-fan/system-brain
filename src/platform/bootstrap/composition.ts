/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Minimal composition root wiring persistence, runtime, capabilities, gateway, admin API.
 *
 * Single place config/env concerns live. No DI framework, no service container,
 * no config subsystem. KIP_PLATFORM_ADMIN_TOKEN is a TEMPORARY bootstrap admin
 * credential (env-only, non-final admin auth) — replace before production.
 */

import { createClient } from '@supabase/supabase-js';
import type { Server } from 'node:http';
import { createHttpApi } from '../api/http-server.ts';
import type { TokenActorMap } from '../api/auth.ts';
import { createProviderStorage } from '../provider/provider.storage.ts';
import { OpenRouterGateway } from '../model-gateway/openrouter.gateway.ts';
import { createSupabaseRuntimePersistence } from '../supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import { RuntimeService } from '../../core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../../core/capability/capability-registry.ts';
import { platformAiEcho } from '../../core/capability/ai-echo.ts';

export interface BootstrapEnv {
  supabaseUrl: string;
  supabaseSecretKey: string;
  openRouterModel?: string;
  tokenActors: TokenActorMap;
}

export function compose(opts: BootstrapEnv): Server {
  const db = createClient(opts.supabaseUrl, opts.supabaseSecretKey) as unknown as SupabaseDatabase;
  const persistence = createSupabaseRuntimePersistence(db);
  const providerStorage = createProviderStorage(db);

  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => input);

  // OpenRouter is the single active provider. Model invocation still only via the gateway.
  const openRouter = new OpenRouterGateway({
    apiKey: '',
    defaultModel: opts.openRouterModel ?? 'openrouter/auto',
  });
  registry.register('platform.ai-echo', platformAiEcho(openRouter));

  const runtime = new RuntimeService(persistence, registry);
  return createHttpApi({
    runtime,
    tokens: opts.tokenActors,
    admin: {
      storage: providerStorage,
      adminApi: { storage: providerStorage, openRouter },
    },
  });
}