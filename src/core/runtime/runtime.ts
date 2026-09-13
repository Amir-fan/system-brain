/**
 * @kip
 * @module runtime
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Normalized runtime result and minimal error taxonomy.
 */

import type { RunTrace } from '../run/run.ts';

export interface RuntimeErrorBase {
  kind: string;
  code: string;
  message: string;
  details?: unknown;
}

export interface ValidationError extends RuntimeErrorBase {
  kind: 'validation';
}
export interface AuthorizationError extends RuntimeErrorBase {
  kind: 'authorization';
}
export interface NotFoundError extends RuntimeErrorBase {
  kind: 'not_found';
}
export interface ProviderError extends RuntimeErrorBase {
  kind: 'provider';
}
export interface RuntimeError extends RuntimeErrorBase {
  kind: 'runtime';
}

export type RunError =
  | ValidationError
  | AuthorizationError
  | NotFoundError
  | ProviderError
  | RuntimeError;

export type RuntimeResult =
  | { ok: true; trace: RunTrace; output?: unknown }
  | { ok: false; trace: RunTrace; error: RunError };