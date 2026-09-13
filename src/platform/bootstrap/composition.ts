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
 *
 * The OpenRouter provider credential is NOT read from env for normal runtime.
 * It is managed via the Admin Provider API and stored in Supabase Vault; on boot
 * the Model Gateway resolves and loads it from provider_configs + Vault.
 * Model Assignment is a control-plane concern: capabilities declare a workload and
 * the ResolvingModelGateway maps it to a model through ModelAssignmentResolver.
 */

import { createClient } from '@supabase/supabase-js';
import type { Server } from 'node:http';
import { createHttpApi } from '../api/http-server.ts';
import type { TokenActorMap } from '../api/auth.ts';
import { createProviderStorage } from '../provider/provider.storage.ts';
import { createSourceStorage } from '../provider/source.storage.ts';
import {
  createModelAssignmentStorage,
  createModelAssignmentResolver,
} from '../provider/model-assignment.ts';
import { OpenRouterGateway } from '../model-gateway/openrouter.gateway.ts';
import { ResolvingModelGateway } from '../model-gateway/resolving-gateway.ts';
import { createSupabaseRuntimePersistence } from '../supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import { RuntimeService } from '../../core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../../core/capability/capability-registry.ts';
import { platformAiCompletion } from '../../core/capability/ai-echo.ts';

export interface BootstrapEnv {
  supabaseUrl: string;
  supabaseSecretKey: string;
  openRouterModel?: string;
  tokenActors: TokenActorMap;
}

export async function compose(opts: BootstrapEnv): Promise<Server> {
  const db = createClient(opts.supabaseUrl, opts.supabaseSecretKey) as unknown as SupabaseDatabase;
  const persistence = createSupabaseRuntimePersistence(db);
  const providerStorage = createProviderStorage(db);
  const sourceStorage = createSourceStorage(db);
  const assignmentStorage = createModelAssignmentStorage(db);
  const assignmentResolver = createModelAssignmentResolver(assignmentStorage);

  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => input);

  // OpenRouter is the single active provider (credential resolved from Vault).
  const openRouter = new OpenRouterGateway({
    apiKey: '',
    defaultModel: opts.openRouterModel ?? 'openrouter/auto',
  });
  const storedKey = await providerStorage.readSecret('openrouter');
  if (storedKey) openRouter.setApiKey(storedKey);

  // Control-plane gateway: resolves workload -> assigned model before the adapter.
  const gateway = new ResolvingModelGateway(openRouter, assignmentResolver);
  registry.register('platform.ai-completion', platformAiCompletion(gateway));
  registry.register('platform.ai-echo', platformAiCompletion(gateway));

  const runtime = new RuntimeService(persistence, registry);
  return createHttpApi({
    runtime,
    tokens: opts.tokenActors,
    sources: { storage: sourceStorage, boundary: persistence },
    admin: {
      storage: providerStorage,
      adminApi: {
        storage: providerStorage,
        assignmentStorage,
        resolver: assignmentResolver,
        openRouter,
      },
    },
  });
}