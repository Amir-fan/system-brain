/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K1-004
 * @purpose Project-scoped retrieval API: ranked evidence for a query.
 *
 * The ordinary response carries the evidence a caller needs (text, source,
 * document, path, heading, score, position). Ranking signals and timings appear
 * ONLY in debug mode, and vectors, SQL internals or provider payloads never
 * appear at all.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { Actor } from '../../core/authorization/actor.ts';
import { MAX_TOP_K, RetrievalFailure } from '../../core/retrieval/retrieval.ts';
import type { RetrievalErrorCode } from '../../core/retrieval/retrieval.ts';
import type { RetrievalService, SearchOutcome } from '../../core/retrieval/retrieval.service.ts';

export interface RetrievalApiDeps {
  service: RetrievalService;
  /** Safe display metadata for provenance: source title + document title. */
  labels: {
    sources(projectId: string, sourceIds: string[]): Promise<Map<string, string>>;
    documents(projectId: string, documentIds: string[]): Promise<Map<string, string>>;
  };
  boundary: ProjectBoundaryReaders;
}

export type RetrievalApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): RetrievalApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): RetrievalApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}) },
});

/** Terminal configuration problems are 409; a genuine engine failure is 500. */
const FAILURE_STATUS: Record<RetrievalErrorCode, number> = {
  RETRIEVAL_QUERY_EMPTY: 400,
  INDEX_MODEL_MISMATCH: 409,
  REINDEX_REQUIRED: 409,
  RETRIEVAL_FAILED: 500,
};

interface SearchBody {
  query?: unknown;
  topK?: unknown;
  sourceIds?: unknown;
  documentIds?: unknown;
  debug?: unknown;
}

const asIdList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return ids.length > 0 ? ids : undefined;
};

export async function handleRetrievalSearch(
  deps: RetrievalApiDeps,
  projectId: string,
  actor: Actor,
  body: SearchBody,
): Promise<RetrievalApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) {
    return fail(
      auth.message,
      auth.kind === 'not_found' ? 'not_found' : 'authorization',
      auth.kind === 'not_found' ? 404 : 403,
    );
  }

  const query = typeof body.query === 'string' ? body.query : '';
  const rawTopK = typeof body.topK === 'number' && Number.isFinite(body.topK) ? Math.trunc(body.topK) : undefined;
  const topK = rawTopK === undefined ? undefined : Math.min(Math.max(rawTopK, 1), MAX_TOP_K);
  const debug = body.debug === true;

  let outcome: SearchOutcome;
  try {
    outcome = await deps.service.search({
      projectId,
      query,
      ...(topK !== undefined ? { topK } : {}),
      filters: {
        ...(asIdList(body.sourceIds) ? { sourceIds: asIdList(body.sourceIds) as string[] } : {}),
        ...(asIdList(body.documentIds) ? { documentIds: asIdList(body.documentIds) as string[] } : {}),
      },
    });
  } catch (error) {
    if (error instanceof RetrievalFailure) {
      return fail(error.message, 'retrieval', FAILURE_STATUS[error.code], error.code);
    }
    return fail('تعذر تنفيذ البحث.', 'retrieval', 500);
  }

  // Provenance labels: resolved inside the project only, never another project's names.
  const sourceIds = [...new Set(outcome.results.map((r) => r.sourceId))];
  const documentIds = [...new Set(outcome.results.map((r) => r.documentId))];
  const [sourceLabels, documentLabels] = await Promise.all([
    deps.labels.sources(projectId, sourceIds),
    deps.labels.documents(projectId, documentIds),
  ]);

  const results = outcome.results.map((r, index) => ({
    position: index + 1,
    text: r.text,
    source: sourceLabels.get(r.sourceId) ?? null,
    document: documentLabels.get(r.documentId) ?? r.logicalPath ?? null,
    logicalPath: r.logicalPath ?? null,
    headingContext: r.headingContext ?? null,
    score: r.score,
    ...(debug ? { signals: r.retrievalSignals } : {}),
  }));

  return ok({
    query: outcome.query,
    resultCount: results.length,
    results,
    ...(debug
      ? {
          model: outcome.modelId,
          candidates: outcome.candidates,
          confidence: outcome.confidence,
          timings: outcome.timings,
        }
      : {}),
  });
}
