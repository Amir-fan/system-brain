/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-008
 * @purpose Provider-neutral authentication contract: Bearer token → canonical Actor.
 *
 * Authentication answers "who is this actor?" Authorization is a separate concern
 * handled by the canonical ProjectBoundary. The API layer never parses JWTs
 * itself; it delegates to an ActorAuthenticator implementation (Supabase in prod,
 * static/fake in tests/dev).
 */

import type { Actor } from '../../core/authorization/actor.ts';

export interface ActorAuthResult {
  /** Canonical actor subject (verified identity). */
  actor: Actor;
}

export interface ActorAuthenticator {
  /** Verify a bearer token and return the trusted Actor. Throws on invalid. */
  authenticate(token: string): Promise<ActorAuthResult>;
}

export class UnauthenticatedError extends Error {
  constructor(message = 'authentication failed') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}