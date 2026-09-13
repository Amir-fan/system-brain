/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-005
 * @purpose Temporary bootstrap platform-admin auth boundary.
 *
 * IMPORTANT: This is a BOOTSTRAP-ONLY primitive for the provider-management
 * slice. It is NOT the final KIP Admin authentication architecture. It exists
 * solely so a platform super-admin (env-only, server-side credential) can manage
 * platform-level provider configuration. There are intentionally no roles /
 * permissions / admin-user tables. Replace with the final admin-auth mechanism
 * before production.
 */

import { timingSafeEqual } from 'node:crypto';

/** Env-sourced bootstrap credential. Never logged, never stored in DB, never returned. */
export function platformAdminToken(): string | undefined {
  return process.env.KIP_PLATFORM_ADMIN_TOKEN;
}

/** Constant-time comparison of a provided bearer token against the configured admin token. */
export function isPlatformAdmin(supplied: string | undefined): boolean {
  const expected = platformAdminToken();
  if (!expected || !supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract bearer token from an Authorization header. */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : undefined;
}