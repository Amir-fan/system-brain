/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K0-011
 * @purpose Project-scoped ingestion API handler.
 *
 * Authorization is the canonical ProjectBoundary (same path as Runtime and the
 * Source Registry) - no second authorization implementation exists. Actor
 * identity always comes from the authenticated request, never from a body field.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';
import type { IngestionJob, IngestionOutput } from '../../core/ingestion/ingestion.types.ts';
import type { IngestionService } from '../../core/ingestion/ingestion.service.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export interface IngestionApiDeps {
  service: IngestionService;
  boundary: ProjectBoundaryReaders;
}

export type IngestionApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): IngestionApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): IngestionApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}) },
});

function boundaryFail(auth: { kind: string; message: string }): IngestionApiResult {
  return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
}

function statusForCode(code: string): number {
  if (code === 'SOURCE_NOT_FOUND' || code === 'INGESTION_NOT_FOUND') return 404;
  if (code === 'INTERNAL_ERROR') return 500;
  return 400;
}

function failureResult(err: unknown): IngestionApiResult {
  if (err instanceof IngestionFailure) {
    const status = statusForCode(err.code);
    return fail(err.message, status === 404 ? 'not_found' : 'validation', status, err.code);
  }
  return fail('internal error', 'runtime', 500, 'INTERNAL_ERROR');
}

/** Public projection: no internal ids beyond the job's own, no raw content. */
const publicJob = (job: IngestionJob) => ({
  id: job.id,
  sourceId: job.sourceId,
  status: job.status,
  attemptNumber: job.attemptNumber,
  triggerType: job.triggerType,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
  failedAt: job.failedAt,
  errorCode: job.errorCode,
  errorMessage: job.errorMessage,
  createdAt: job.createdAt,
});

const outputSummary = (output?: IngestionOutput) =>
  output ? { contentType: output.contentType, charCount: output.charCount, contentSha256: output.contentSha256 } : undefined;

/** POST /v1/projects/{p}/sources/{s}/ingestions */
export async function handleCreateIngestion(
  deps: IngestionApiDeps,
  projectId: string,
  sourceId: string,
  actor: Actor,
): Promise<IngestionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);
  try {
    const outcome = await deps.service.ingest({ projectId, sourceId, actor });
    return ok(
      {
        job: publicJob(outcome.job),
        reused: outcome.reused,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outputSummary(outcome.output) ? { output: outputSummary(outcome.output) } : {}),
      },
      outcome.reused ? 200 : 201,
    );
  } catch (err) {
    return failureResult(err);
  }
}

/** GET /v1/projects/{p}/sources/{s}/ingestions */
export async function handleListSourceIngestions(
  deps: IngestionApiDeps,
  projectId: string,
  sourceId: string,
  actor: Actor,
): Promise<IngestionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const jobs = await deps.service.listForSource(projectId, sourceId);
  return ok(jobs.map(publicJob));
}

/** GET /v1/projects/{p}/ingestions - latest job per source (drives the Knowledge list). */
export async function handleListProjectIngestions(
  deps: IngestionApiDeps,
  projectId: string,
  actor: Actor,
): Promise<IngestionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const jobs = await deps.service.listLatestByProject(projectId);
  return ok(jobs.map(publicJob));
}

/** GET /v1/projects/{p}/ingestions/{i} */
export async function handleGetIngestion(
  deps: IngestionApiDeps,
  projectId: string,
  ingestionId: string,
  actor: Actor,
): Promise<IngestionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const job = await deps.service.getJob(projectId, ingestionId);
  if (!job) return fail('ingestion not found', 'not_found', 404, 'INGESTION_NOT_FOUND');
  return ok(publicJob(job));
}

/** POST /v1/projects/{p}/ingestions/{i}/retry - a deliberate new run. */
export async function handleRetryIngestion(
  deps: IngestionApiDeps,
  projectId: string,
  ingestionId: string,
  actor: Actor,
): Promise<IngestionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);
  const job = await deps.service.getJob(projectId, ingestionId);
  if (!job) return fail('ingestion not found', 'not_found', 404, 'INGESTION_NOT_FOUND');
  try {
    const outcome = await deps.service.retry(projectId, job.sourceId, actor);
    return ok({ job: publicJob(outcome.job), reused: outcome.reused, ...(outcome.reason ? { reason: outcome.reason } : {}) }, 201);
  } catch (err) {
    return failureResult(err);
  }
}
