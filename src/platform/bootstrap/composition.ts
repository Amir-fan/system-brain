/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Minimal composition root wiring persistence, runtime, capabilities, gateway, and API.
 *
 * This is the single place config/env concerns live. No DI framework, no
 * service container, no config subsystem.
 */

import { createClient } from '@supabase/supabase-js';
import type { Server } from 'node:http';
import { createHttpApi } from '../api/http-server.ts';
import type { TokenActorMap } from '../api/auth.ts';
import { OpenAiGateway } from '../model-gateway/openai.gateway.ts';
import { createSupabaseRuntimePersistence } from '../supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import { RuntimeService } from '../../core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../../core/capability/capability-registry.ts';
import { platformAiEcho } from '../../core/capability/ai-echo.ts';

export interface BootstrapEnv {
  supabaseUrl: string;
  supabaseSecretKey: string;
  openaiApiKey?: string;
  openaiModel?: string;
  tokenActors: TokenActorMap;
}

export function compose(opts: BootstrapEnv): Server {
  const db = createClient(opts.supabaseUrl, opts.supabaseSecretKey) as unknown as SupabaseDatabase;
  const persistence = createSupabaseRuntimePersistence(db);

  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => input);

  if (opts.openaiApiKey) {
    const gateway = new OpenAiGateway({ apiKey: opts.openaiApiKey, model: opts.openaiModel ?? 'gpt-4o-mini' });
    registry.register('platform.ai-echo', platformAiEcho(gateway));
  }

  const runtime = new RuntimeService(persistence, registry);
  return createHttpApi({ runtime, tokens: opts.tokenActors });
}