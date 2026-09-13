/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-008
 * @purpose DEV/TEST-COMPAT static-token actor authenticator.
 *
 * Backwards-compatible bridge for the legacy KIP_API_TOKENS mechanism.
 * It is NOT a production identity source: no new feature depends on it and it is
 * never exposed to the browser. Tests/dev-only — replace with a real identity
 * provider (Supabase Auth) in production.
 */

import { ActorAuthenticator, UnauthenticatedError, ActorAuthResult } from './actor-authenticator.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export type TokenActorMap = ReadonlyMap<string, Actor>;

export class StaticTokenAuthenticator implements ActorAuthenticator {
  constructor(private readonly map: TokenActorMap) {}

  async authenticate(token: string): Promise<ActorAuthResult> {
    const actor = token ? this.map.get(token) : undefined;
    if (!actor) throw new UnauthenticatedError('invalid static token');
    return { actor };
  }
}