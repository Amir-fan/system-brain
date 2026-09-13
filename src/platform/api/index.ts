/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Wire the KIP API: runtime + ActorAuthenticator → HTTP listener.
 */

import type { RuntimePersistence } from '../../core/runtime/runtime.ports.ts';
import type { CapabilityLookup } from '../../core/capability/capability.ts';
import { RuntimeService } from '../../core/runtime/runtime.service.ts';
import { createHttpApi } from './http-server.ts';
import { StaticTokenAuthenticator } from './static-authenticator.ts';
import type { ActorAuthenticator } from './actor-authenticator.ts';
import type { TokenActorMap } from './auth.ts';
import type { Server } from 'node:http';

export interface KipApiOptions {
  persistence: RuntimePersistence;
  capabilities: CapabilityLookup;
  /** Dev/test-compat token map OR a real ActorAuthenticator. */
  tokens?: TokenActorMap;
  authenticator?: ActorAuthenticator;
}

export function createKipApi(opts: KipApiOptions): Server {
  const runtime = new RuntimeService(opts.persistence, opts.capabilities);
  const authenticator =
    opts.authenticator ?? (opts.tokens ? new StaticTokenAuthenticator(opts.tokens) : (() => {
      throw new Error('createKipApi requires tokens (dev) or authenticator (prod)');
    })());
  return createHttpApi({ runtime, authenticator });
}