/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-010
 * @purpose Tamper-resistant, short-lived connection state for external connectors.
 *
 * A connector callback arrives as a bare browser redirect and therefore carries
 * NO bearer token. The callback must never trust a naked project_id, so the
 * authenticated user first asks KIP for a signed state binding:
 *   initiating project + initiating actor + expiry + nonce.
 * Missing/expired/tampered state is refused before any installation is bound.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ConnectionState {
  projectId: string;
  actor: string;
  /** Unix seconds. */
  exp: number;
  nonce: string;
}

export const STATE_TTL_SECONDS = 15 * 60;

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(secret: string, payload: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

export function createConnectionState(
  secret: string,
  input: { projectId: string; actor: string },
  now = Date.now(),
): string {
  const state: ConnectionState = {
    projectId: input.projectId,
    actor: input.actor,
    exp: Math.floor(now / 1000) + STATE_TTL_SECONDS,
    nonce: randomBytes(12).toString('hex'),
  };
  const payload = b64url(JSON.stringify(state));
  return `${payload}.${sign(secret, payload)}`;
}

export type StateVerification =
  | { ok: true; state: ConnectionState }
  | { ok: false; reason: 'missing' | 'malformed' | 'tampered' | 'expired' };

export function verifyConnectionState(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): StateVerification {
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };

  const [payload, signature] = parts;
  const expected = sign(secret, payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'tampered' };

  let parsed: ConnectionState;
  try {
    parsed = JSON.parse(fromB64url(payload).toString('utf8')) as ConnectionState;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed.projectId || !parsed.actor || typeof parsed.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (parsed.exp <= Math.floor(now / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, state: parsed };
}
