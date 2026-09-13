/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Minimal trusted-credential → Actor authentication boundary.
 *
 * Converts a verified external credential (project integration token) into the
 * canonical Actor. Runtime never sees HTTP or auth-provider details. The Actor
 * is resolved here from a trusted context — never from the request body.
 */

import type { Actor } from '../../core/authorization/actor.ts';

export type TokenActorMap = ReadonlyMap<string, Actor>;

/** Resolve a bearer token to a trusted Actor, or undefined if invalid. */
export function actorFromToken(token: string | undefined, map: TokenActorMap): Actor | undefined {
  if (!token) return undefined;
  return map.get(token);
}