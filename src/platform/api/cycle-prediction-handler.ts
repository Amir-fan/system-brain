import type { Actor } from '../../core/authorization/actor.ts';
import {
  authorizeProject,
  type BoundaryDecision,
  type ProjectBoundaryReaders,
} from '../../core/authorization/project-boundary.ts';
import {
  CyclePredictionFailure,
  predictCycle,
  type CyclePredictionFailureCode,
  type CyclePredictionInput,
  type CyclePredictionResult,
} from '../../domain/naqaa/cycle-prediction.ts';

export interface CyclePredictionApiDeps {
  boundary: ProjectBoundaryReaders;
  currentDate?: () => string;
}

export type CyclePredictionBodyReader = () => unknown | Promise<unknown>;

export class CyclePredictionRequestFailure extends Error {
  readonly code = 'PREDICTION_REQUEST_INVALID' as const;

  constructor() {
    super('Invalid cycle prediction request body');
    this.name = 'CyclePredictionRequestFailure';
  }
}

export type CyclePredictionApiResult =
  | { ok: true; status: 200; data: CyclePredictionResult }
  | {
    ok: false;
    status: 400;
    error: {
      category: 'validation';
      message: 'invalid cycle prediction request' | 'invalid cycle prediction request body';
      code: CyclePredictionFailureCode | 'PREDICTION_REQUEST_INVALID';
    };
  }
  | {
    ok: false;
    status: 403;
    error: { category: 'authorization'; message: string };
  }
  | {
    ok: false;
    status: 404;
    error: { category: 'not_found'; message: string };
  }
  | {
    ok: false;
    status: 500;
    error: { category: 'runtime'; message: 'cycle prediction unavailable' };
  };

const CURRENT_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function internalFailure(): CyclePredictionApiResult {
  return {
    ok: false,
    status: 500,
    error: { category: 'runtime', message: 'cycle prediction unavailable' },
  };
}

function boundaryFailure(
  decision: Extract<BoundaryDecision, { ok: false }>,
): CyclePredictionApiResult {
  if (decision.kind === 'not_found') {
    return {
      ok: false,
      status: 404,
      error: { category: 'not_found', message: decision.message },
    };
  }
  return {
    ok: false,
    status: 403,
    error: { category: 'authorization', message: decision.message },
  };
}

function isSupportedCurrentDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CURRENT_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return year >= 1900
    && year <= 9999
    && date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

function defaultCurrentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function handleCyclePrediction(
  deps: CyclePredictionApiDeps,
  projectId: string,
  actor: Actor,
  body: unknown,
): Promise<CyclePredictionApiResult> {
  return handleCyclePredictionRequest(deps, projectId, actor, () => body);
}

export async function handleCyclePredictionRequest(
  deps: CyclePredictionApiDeps,
  projectId: string,
  actor: Actor,
  readBody: CyclePredictionBodyReader,
): Promise<CyclePredictionApiResult> {
  let authorization: BoundaryDecision;
  try {
    authorization = await authorizeProject(deps.boundary, projectId, actor, 'read');
  } catch {
    return internalFailure();
  }

  if (!authorization.ok) return boundaryFailure(authorization);

  let currentDate: string;
  try {
    const configuredCurrentDate = deps.currentDate;
    const suppliedCurrentDate = configuredCurrentDate === undefined
      ? defaultCurrentDate()
      : configuredCurrentDate.call(deps);
    if (!isSupportedCurrentDate(suppliedCurrentDate)) return internalFailure();
    currentDate = suppliedCurrentDate;
  } catch {
    return internalFailure();
  }

  let body: unknown;
  try {
    body = await readBody();
  } catch (error) {
    if (error instanceof CyclePredictionRequestFailure) {
      return {
        ok: false,
        status: 400,
        error: {
          category: 'validation',
          message: 'invalid cycle prediction request body',
          code: error.code,
        },
      };
    }
    return internalFailure();
  }

  try {
    const prediction = predictCycle(body as CyclePredictionInput, currentDate);
    return { ok: true, status: 200, data: prediction };
  } catch (error) {
    if (error instanceof CyclePredictionFailure) {
      return {
        ok: false,
        status: 400,
        error: {
          category: 'validation',
          message: 'invalid cycle prediction request',
          code: error.code,
        },
      };
    }
    return internalFailure();
  }
}
