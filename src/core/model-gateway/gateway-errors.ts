/**
 * @kip
 * @module model-gateway
 * @layer core
 * @owner platform-core
 * @feature K0-004
 * @purpose Normalized provider-error factory consumed by provider adapters.
 */

import type { ProviderError } from '../runtime/runtime.ts';

/**
 * Build the canonical `provider` error category. Provider adapters use this so
 * raw SDK failures (auth, timeout, rate limit, malformed response) normalize
 * without leaking provider internals upstream.
 */
export function providerError(message: string, code = 'PROVIDER_ERROR', details?: unknown): ProviderError {
  return { kind: 'provider', code, message, details };
}

/**
 * True when a thrown value is a normalized provider/transport failure. Callers use this to
 * keep a TECHNICAL failure distinct from a domain outcome (e.g. insufficient evidence).
 */
export function isProviderError(e: unknown): e is ProviderError {
  return typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'provider';
}