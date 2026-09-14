/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K1-001
 * @purpose Project-scoped canonical Document read API.
 *
 * Documents are produced by ingestion; this handler is read-only. Authorization
 * is the canonical ProjectBoundary, and every query is project-scoped, so another
 * project cannot list or read a document (and gains nothing from error shapes).
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { IngestionPersistence } from '../../core/ingestion/ingestion.ports.ts';
import type { DocumentRecord, DocumentSummary } from '../../core/ingestion/document.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export interface DocumentApiDeps {
  persistence: IngestionPersistence;
  boundary: ProjectBoundaryReaders;
}

export type DocumentApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): DocumentApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400): DocumentApiResult => ({
  ok: false,
  status,
  error: { message, category },
});

function boundaryFail(auth: { kind: string; message: string }): DocumentApiResult {
  return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
}

/** List projection: metadata only, never the normalized text. */
const publicSummary = (doc: DocumentSummary) => ({
  id: doc.id,
  sourceId: doc.sourceId,
  title: doc.title,
  logicalPath: doc.logicalPath,
  contentType: doc.contentType,
  charCount: doc.charCount,
  contentSha256: doc.contentSha256,
  ordinal: doc.ordinal,
  createdAt: doc.createdAt,
});

/** Single document: includes the normalized text for inspection. */
const publicDocument = (doc: DocumentRecord) => ({
  ...publicSummary(doc),
  normalizedText: doc.normalizedText,
});

/**
 * GET /v1/projects/{p}/sources/{s}/documents
 * Defaults to the latest COMPLETED ingestion; an explicit ingestionId can be
 * supplied so each historical snapshot stays addressable.
 */
export async function handleListSourceDocuments(
  deps: DocumentApiDeps,
  projectId: string,
  sourceId: string,
  actor: Actor,
  ingestionId?: string,
): Promise<DocumentApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);

  let jobId = ingestionId;
  if (!jobId) {
    const latest = await deps.persistence.latestCompletedJob(projectId, sourceId);
    if (!latest) return ok({ ingestionId: null, documents: [] });
    jobId = latest.id;
  }
  const summaries = await deps.persistence.listDocumentSummaries(projectId, sourceId, jobId);
  return ok({ ingestionId: jobId, documents: summaries.map(publicSummary) });
}

/** GET /v1/projects/{p}/documents/{id} */
export async function handleGetDocument(
  deps: DocumentApiDeps,
  projectId: string,
  documentId: string,
  actor: Actor,
): Promise<DocumentApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const doc = await deps.persistence.getDocument(projectId, documentId);
  if (!doc) return fail('document not found', 'not_found', 404);
  return ok(publicDocument(doc));
}
