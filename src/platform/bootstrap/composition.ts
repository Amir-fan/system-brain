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
import { SupabaseActorAuthenticator } from '../api/supabase-authenticator.ts';
import { StaticTokenAuthenticator } from '../api/static-authenticator.ts';
import type { TokenActorMap } from '../api/auth.ts';
import { createProjectDiscoveryStorage } from '../api/project-discovery.ts';
import { createProviderStorage } from '../provider/provider.storage.ts';
import { createSourceStorage } from '../provider/source.storage.ts';
import { createRawArtifactStorage } from '../provider/raw-artifact.storage.ts';
import { createExternalConnectionStorage } from '../provider/external-connection.storage.ts';
import { createSupabaseRawStorage } from '../storage/raw-storage.ts';
import type { SupabaseStorageClient } from '../storage/raw-storage.ts';
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
  /** DEV/TEST-COMPAT static tokens (legacy KIP_API_TOKENS); optional. */
  tokenActors?: TokenActorMap;
}

export async function compose(opts: BootstrapEnv): Promise<Server> {
  const rawClient = createClient(opts.supabaseUrl, opts.supabaseSecretKey);
  const db = rawClient as unknown as SupabaseDatabase;
  const persistence = createSupabaseRuntimePersistence(db);
  const providerStorage = createProviderStorage(db);
  const sourceStorage = createSourceStorage(db);
  const artifactStorage = createRawArtifactStorage(db);
  const connectionStorage = createExternalConnectionStorage(db);
  // Private raw-file storage (server credential only; browser never sees it).
  const rawStorage = createSupabaseRawStorage(rawClient as unknown as SupabaseStorageClient);
  const assignmentStorage = createModelAssignmentStorage(db);
  const assignmentResolver = createModelAssignmentResolver(assignmentStorage);
  const projectDiscovery = createProjectDiscoveryStorage(db);

  // Identity source: Supabase Auth (production); static tokens only as dev/test-compat.
  const authenticator =
    opts.tokenActors && opts.tokenActors.size > 0
      ? new StaticTokenAuthenticator(opts.tokenActors)
      : new SupabaseActorAuthenticator({ auth: rawClient.auth });

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
    authenticator,
    projects: projectDiscovery,
    sources: {
      storage: sourceStorage,
      boundary: persistence,
      artifacts: artifactStorage,
      references: connectionStorage,
      rawStorage,
    },
    connections: {
      connections: connectionStorage,
      storage: sourceStorage,
      boundary: persistence,
    },
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