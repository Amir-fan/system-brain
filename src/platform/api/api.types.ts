/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose KIP API envelope and request/response types (platform boundary).
 */

import type { ErrorCategory } from '../../core/run/run.ts';

export const HTTP_STATUS: Record<ErrorCategory | 'success', number> = {
  validation: 400,
  authorization: 403,
  not_found: 404,
  provider: 502,
  runtime: 500,
  success: 200,
};

export interface InvokeRunRequest {
  capability: string;
  input: unknown;
}

export type ApiResult =
  | { ok: true; status: number; runId: string; result: unknown }
  | { ok: false; status: number; error: { category: ErrorCategory; message: string } };