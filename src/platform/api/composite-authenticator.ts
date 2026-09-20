/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-008
 * @purpose Stage 3 cutover — composite authenticator + trusted server-to-server actor.
 *
 * Production identity stays Supabase Auth for browser/direct users. A SEPARATE,
 * env-held server credential (KIP_PROXY_TOKENS) lets a trusted backend proxy (the
 * Naqaa Supabase Edge Function) authenticate as a `service` actor AFTER it has
 * verified the end user's own Supabase session. The proxy then conveys the verified
 * end-user id via `x-kip-actor`, which is honored ONLY when the bearer token resolved
 * through the proxy credential — never for a Supabase/browser caller. Project
 * authorization (membership) is still enforced against the service actor by the
 * canonical boundary; the end-user id only scopes per-user memory + conversation
 * ownership. This is the minimal server-to-server path approved for the cutover —
 * NOT a general auth redesign.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ActorAuthenticator, UnauthenticatedError, ActorAuthResult } from './actor-authenticator.ts';
import type { Actor } from '../../core/authorization/actor.ts';

/** Result of a composite authenticate: the canonical actor + whether the bearer is the
 * trusted proxy (only then may a caller-supplied end-user subject be honored). */
export interface CompositeAuthResult extends ActorAuthResult {
  isProxy: boolean;
}

export class CompositeActorAuthenticator implements ActorAuthenticator {
  constructor(
    private readonly supabase: Pick<SupabaseClient, 'auth'>,
    private readonly proxyTokens: ReadonlyMap<string, Actor>,
  ) {}

  async authenticate(token: string): Promise<ActorAuthResult> {
    return this.authenticateComposite(token);
  }

  async authenticateComposite(token: string): Promise<CompositeAuthResult> {
    if (!token) throw new UnauthenticatedError('missing token');
    // 1. Browser/direct users: Supabase Auth (unchanged production path).
    try {
      const { data, error } = await this.supabase.auth.getUser(token);
      if (!error && data.user) return { actor: data.user.id, isProxy: false };
    } catch {
      /* fall through to proxy credential */
    }
    // 2. Trusted server-to-server proxy (constant-time membership check).
    const svc = this.proxyTokens.get(token);
    if (svc) return { actor: svc, isProxy: true };
    throw new UnauthenticatedError('invalid access token');
  }
}

/** Parse `KIP_PROXY_TOKENS` = "actor:token,actor:token" (same shape as KIP_API_TOKENS,
 * but a distinct, production-intended server credential — never the dev/test map). */
export function proxyTokensFromEnv(raw: string | undefined): Map<string, Actor> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const [actor, token] = pair.split(':');
    if (actor && token) map.set(token.trim(), actor.trim());
  }
  return map;
}
