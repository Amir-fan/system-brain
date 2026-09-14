/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K1-002
 * @purpose Project-scoped canonical Chunk read API.
 *
 * Chunks are produced by ingestion; this handler is read-only. Authorization is
 * the canonical ProjectBoundary and every query is project-scoped, so another
 * project can neither list nor read a chunk. The list projection stays metadata
 * plus a short preview; only the single-chunk read returns the full text.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { IngestionPersistence } from '../../core/ingestion/ingestion.ports.ts';
import type { ChunkRecord, ChunkSummary } from '../../core/ingestion/chunk.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export interface ChunkApiDeps {
  persistence: IngestionPersistence;
  boundary: ProjectBoundaryReaders;
}

export type ChunkApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): ChunkApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400): ChunkApiResult => ({
  ok: false,
  status,
  error: { message, category },
});

function boundaryFail(auth: { kind: string; message: string }): ChunkApiResult {
  return fail(
    auth.message,
    auth.kind === 'not_found' ? 'not_found' : 'authorization',
    auth.kind === 'not_found' ? 404 : 403,
  );
}

/** List projection: position, context and a short preview - never the full body. */
const publicChunkSummary = (c: ChunkSummary) => ({
  id: c.id,
  documentId: c.documentId,
  chunkIndex: c.chunkIndex,
  logicalPath: c.logicalPath,
  headingContext: c.headingContext,
  charCount: c.charCount,
  contentSha256: c.contentSha256,
  preview: c.preview,
});

/** Single chunk: includes the full chunk text. */
const publicChunk = (c: ChunkRecord) => ({
  id: c.id,
  documentId: c.documentId,
  sourceId: c.sourceId,
  chunkIndex: c.index,
  chunkKey: c.key,
  logicalPath: c.logicalPath,
  headingContext: c.headingContext,
  charCount: c.charCount,
  contentSha256: c.sha256,
  startChar: c.startChar,
  endChar: c.endChar,
  text: c.text,
  createdAt: c.createdAt,
});

/** GET /v1/projects/{p}/documents/{id}/chunks */
export async function handleListDocumentChunks(
  deps: ChunkApiDeps,
  projectId: string,
  documentId: string,
  actor: Actor,
): Promise<ChunkApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);

  // A document that is not visible in this project must not leak its existence.
  const doc = await deps.persistence.getDocument(projectId, documentId);
  if (!doc) return fail('document not found', 'not_found', 404);

  const chunks = await deps.persistence.listChunkSummaries(projectId, documentId);
  return ok({ documentId, chunkCount: chunks.length, chunks: chunks.map(publicChunkSummary) });
}

/** GET /v1/projects/{p}/chunks/{id} */
export async function handleGetChunk(
  deps: ChunkApiDeps,
  projectId: string,
  chunkId: string,
  actor: Actor,
): Promise<ChunkApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const chunk = await deps.persistence.getChunk(projectId, chunkId);
  if (!chunk) return fail('chunk not found', 'not_found', 404);
  return ok(publicChunk(chunk));
}
