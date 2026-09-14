/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K1-003
 * @purpose Project-scoped embedding API: trigger indexing and read index readiness.
 *
 * Authorization is the canonical ProjectBoundary and every query is project
 * scoped, so another project can neither trigger indexing, read a job, nor learn
 * that a source exists. Responses carry counters and states only — never vectors,
 * never chunk text, never provider credentials or raw provider errors.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { Actor } from '../../core/authorization/actor.ts';
import { EmbeddingFailure } from '../../core/embedding/embedding.ts';
import type { EmbeddingErrorCode, EmbeddingJobSummary, EmbeddingPersistence } from '../../core/embedding/embedding.ts';
import { indexReadiness } from '../../core/embedding/embedding.service.ts';
import type { EmbeddingService, IngestionSnapshotReader } from '../../core/embedding/embedding.service.ts';
import type { ModelAssignmentResolver } from '../provider/model-assignment.ts';

export interface EmbeddingApiDeps {
  service: EmbeddingService;
  persistence: EmbeddingPersistence;
  ingestion: IngestionSnapshotReader;
  resolver: ModelAssignmentResolver;
  /** Source visibility inside THIS project: a foreign source must answer 404. */
  sources: { exists(projectId: string, sourceId: string): Promise<boolean> };
  boundary: ProjectBoundaryReaders;
}

export type EmbeddingApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): EmbeddingApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): EmbeddingApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}) },
});

function boundaryFail(auth: { kind: string; message: string }): EmbeddingApiResult {
  return fail(
    auth.message,
    auth.kind === 'not_found' ? 'not_found' : 'authorization',
    auth.kind === 'not_found' ? 404 : 403,
  );
}

/** HTTP mapping for typed embedding failures. Terminal config problems are not 5xx. */
const FAILURE_STATUS: Record<EmbeddingErrorCode, number> = {
  EMBEDDING_ASSIGNMENT_MISSING: 409,
  EMBEDDING_NOTHING_TO_INDEX: 409,
  EMBEDDING_PROVIDER_FAILED: 502,
  EMBEDDING_DIMENSION_MISMATCH: 502,
  EMBEDDING_PERSISTENCE_FAILED: 500,
};

/** Job projection: counters and states only. No vectors, no provider payloads. */
const publicJob = (job: EmbeddingJobSummary) => ({
  id: job.id,
  status: job.status,
  modelId: job.modelId,
  dimensions: job.dimensions,
  chunksRequested: job.chunksRequested,
  chunksEmbedded: job.chunksEmbedded,
  chunksReused: job.chunksReused,
  batchCount: job.batchCount,
  inputTokens: job.inputTokens,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
  failedAt: job.failedAt,
  errorCode: job.errorCode,
  errorMessage: job.errorMessage,
  createdAt: job.createdAt,
});

async function assignedEmbeddingModel(deps: EmbeddingApiDeps): Promise<string | null> {
  try {
    const resolved = await deps.resolver.resolve({ profile: 'embeddings' });
    return resolved.modelId;
  } catch {
    return null;
  }
}

/** POST /v1/projects/{p}/sources/{s}/embeddings — explicit trigger / reindex. */
export async function handleIndexSource(
  deps: EmbeddingApiDeps,
  projectId: string,
  sourceId: string,
  actor: Actor,
): Promise<EmbeddingApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);
  // A source that is not visible in this project answers 404 — never 409, which
  // would hint that the id exists somewhere else.
  if (!(await deps.sources.exists(projectId, sourceId))) {
    return fail('source not found', 'not_found', 404);
  }

  try {
    const result = await deps.service.indexKnowledge({ projectId, sourceId, actor });
    const latest = await deps.persistence.latestJobForSource(projectId, sourceId);
    return ok(
      {
        job: latest ? publicJob(latest) : publicJob({ ...result.job, sourceId } as unknown as EmbeddingJobSummary),
        reused: result.reused,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      202,
    );
  } catch (error) {
    if (error instanceof EmbeddingFailure) {
      return fail(error.message, 'embedding', FAILURE_STATUS[error.code], error.code);
    }
    return fail('تعذر تجهيز الفهرسة.', 'embedding', 500);
  }
}

/**
 * GET /v1/projects/{p}/sources/{s}/embeddings
 * Two concepts, reported separately: content readiness (ingestion) and index
 * readiness (embeddings for the currently assigned model).
 */
export async function handleIndexStatus(
  deps: EmbeddingApiDeps,
  projectId: string,
  sourceId: string,
  actor: Actor,
): Promise<EmbeddingApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  if (!(await deps.sources.exists(projectId, sourceId))) {
    return fail('source not found', 'not_found', 404);
  }

  const modelId = await assignedEmbeddingModel(deps);
  const snapshot = await deps.ingestion.latestCompletedIngestion(projectId, sourceId);
  const job = await deps.persistence.latestJobForSource(projectId, sourceId);

  if (!snapshot) {
    return ok({
      content: { ready: false, chunkCount: 0 },
      index: { state: 'none', modelId, modelMatches: false, embeddedChunks: 0, totalChunks: 0 },
      job: job ? publicJob(job) : null,
    });
  }

  const totalChunks = await deps.persistence.countChunks(projectId, snapshot.id);
  const embeddedChunks = modelId
    ? await deps.persistence.countEmbeddings(projectId, snapshot.id, modelId)
    : 0;
  const modelMatches = Boolean(modelId && job && job.modelId === modelId);

  return ok({
    content: { ready: true, chunkCount: totalChunks },
    index: {
      state: indexReadiness({
        totalChunks,
        embeddedChunks,
        ...(job ? { latestJobStatus: job.status } : {}),
        modelMatches,
      }),
      modelId,
      modelMatches,
      embeddedChunks,
      totalChunks,
    },
    job: job ? publicJob(job) : null,
  });
}

/** GET /v1/projects/{p}/embedding-jobs/{jobId} */
export async function handleGetEmbeddingJob(
  deps: EmbeddingApiDeps,
  projectId: string,
  jobId: string,
  actor: Actor,
): Promise<EmbeddingApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const job = await deps.persistence.getJob(projectId, jobId);
  if (!job) return fail('embedding job not found', 'not_found', 404);
  return ok(publicJob(job));
}
