/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-ingestion
 * @feature K1-001
 * @purpose Canonical Document vocabulary (the K12 logical knowledge unit).
 *
 * A Document is the canonical logical knowledge unit produced by a successful
 * ingestion. It is NOT a Source, Raw Artifact, Ingestion Job, or Chunk. Identity
 * is deterministic at the logical-unit level (document_key) and unique within
 * one ingestion, so a re-ingestion produces a new snapshot instead of
 * overwriting history.
 */

export interface DocumentRecord {
  id: string;
  projectId: string;
  sourceId: string;
  ingestionJobId: string;
  ingestionOutputId?: string;
  /** Deterministic logical identity within the ingestion, e.g. github:src/a.ts */
  documentKey: string;
  title?: string;
  logicalPath?: string;
  contentType: 'text/plain';
  normalizedText: string;
  contentSha256: string;
  charCount: number;
  /** Stable position of this unit within the ingestion (0-based). */
  ordinal: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentInput {
  projectId: string;
  sourceId: string;
  ingestionJobId: string;
  ingestionOutputId?: string;
  documentKey: string;
  title?: string;
  logicalPath?: string;
  normalizedText: string;
  contentSha256: string;
  charCount: number;
  ordinal: number;
}

/** Metadata-only projection for list views: never includes normalized text. */
export type DocumentSummary = Omit<DocumentRecord, 'normalizedText'>;
