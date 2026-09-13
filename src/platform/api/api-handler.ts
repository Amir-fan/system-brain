/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Bridge from an API request to the single Runtime path.
 *
 * This layer authenticates, validates, and translates to Runtime. It never
 * creates or mutates Runs directly — RuntimeService remains the sole owner.
 */

import type { Actor } from '../../core/authorization/actor.ts';
import type { RuntimeService } from '../../core/runtime/runtime.service.ts';
import { HTTP_STATUS } from './api.types.ts';
import type { ApiResult, InvokeRunRequest } from './api.types.ts';

export interface AuthenticatedInvoke {
  actor: Actor;
  projectId: string;
  request: InvokeRunRequest;
}

export async function handleInvoke(runtime: RuntimeService, ctx: AuthenticatedInvoke): Promise<ApiResult> {
  const validation = validate(ctx.request);
  if (validation) return validation;

  const result = await runtime.execute({
    projectId: ctx.projectId,
    actor: ctx.actor,
    capability: ctx.request.capability,
    input: ctx.request.input,
  });

  if ('error' in result) {
    return {
      ok: false,
      status: HTTP_STATUS[result.error.kind],
      error: { category: result.error.kind, message: result.error.message },
    };
  }
  // A failed run is still a normalized outcome (no error object) — surface it as 500/runtime.
  if (result.status === 'failed') {
    return {
      ok: false,
      status: HTTP_STATUS.runtime,
      error: { category: 'runtime', message: 'run failed' },
    };
  }
  return { ok: true, status: HTTP_STATUS.success, runId: result.id, result: result.output };
}

function validate(request: InvokeRunRequest): ApiResult | null {
  if (!request || typeof request !== 'object') {
    return errorResponse('validation', 'invalid request body');
  }
  if (typeof request.capability !== 'string' || request.capability.length === 0) {
    return errorResponse('validation', 'capability is required');
  }
  if (request.input === undefined) {
    return errorResponse('validation', 'input is required');
  }
  return null;
}

function errorResponse(category: 'validation', message: string): ApiResult {
  return { ok: false, status: HTTP_STATUS[category], error: { category, message } };
}