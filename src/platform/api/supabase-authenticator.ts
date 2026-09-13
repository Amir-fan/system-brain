/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-008
 * @purpose Production Supabase-backed ActorAuthenticator.
 *
 * Verifies the access token against Supabase Auth (server-side) and returns the
 * canonical Actor = supabase user id (`sub`). Never trusts client-decoded JWTs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ActorAuthenticator, UnauthenticatedError, ActorAuthResult } from './actor-authenticator.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export class SupabaseActorAuthenticator implements ActorAuthenticator {
  constructor(private readonly admin: Pick<SupabaseClient, 'auth'>) {}

  async authenticate(token: string): Promise<ActorAuthResult> {
    if (!token) throw new UnauthenticatedError('missing token');
    const { data, error } = await this.admin.auth.getUser(token);
    if (error || !data.user) throw new UnauthenticatedError('invalid access token');
    const actor: Actor = data.user.id; // canonical Supabase `sub`
    return { actor };
  }
}