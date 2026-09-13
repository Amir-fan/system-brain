/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Wire the KIP API: runtime + token→Actor map → HTTP listener.
 */

import type { RuntimePersistence } from '../../core/runtime/runtime.ports.ts';
import type { CapabilityLookup } from '../../core/capability/capability.ts';
import { RuntimeService } from '../../core/runtime/runtime.service.ts';
import { createHttpApi } from './http-server.ts';
import type { TokenActorMap } from './auth.ts';
import type { Server } from 'node:http';

export interface KipApiOptions {
  persistence: RuntimePersistence;
  capabilities: CapabilityLookup;
  tokens: TokenActorMap;
}

export function createKipApi(opts: KipApiOptions): Server {
  const runtime = new RuntimeService(opts.persistence, opts.capabilities);
  return createHttpApi({ runtime, tokens: opts.tokens });
}