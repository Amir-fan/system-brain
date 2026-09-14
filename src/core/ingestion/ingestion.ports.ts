/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-ingestion
 * @feature K0-011
 * @purpose Ingestion ports (dependency-inverted boundaries).
 *
 * Core defines what ingestion needs; the platform supplies Supabase-backed
 * implementations and per-source-type acquisition adapters. No ORM, no generic
 * repository, no queue abstraction.
 */

import type {
  AcquiredContent,
  CreateIngestionJobInput,
  IngestionJob,
  IngestionOutput,
  SaveIngestionOutputInput,
} from './ingestion.types.ts';
import type { SourceType } from '../project/source-type.ts';
import type { CreateDocumentInput, DocumentRecord, DocumentSummary } from './document.ts';
import type { ChunkRecord, ChunkSummary, CreateChunkInput } from './chunk.ts';

/** Raised when the database refuses a second active job for the same source. */
export class ActiveIngestionJobExistsError extends Error {
  constructor() {
    super('active ingestion job already exists');
    this.name = 'ActiveIngestionJobExistsError';
  }
}

export interface IngestionPersistence {
  findActiveJob(projectId: string, sourceId: string): Promise<IngestionJob | null>;
  getJob(projectId: string, jobId: string): Promise<IngestionJob | null>;
  latestJob(projectId: string, sourceId: string): Promise<IngestionJob | null>;
  listJobs(projectId: string, sourceId: string): Promise<IngestionJob[]>;
  /** Most recent job per source for a whole project (drives the Knowledge list). */
  listLatestJobsByProject(projectId: string): Promise<IngestionJob[]>;
  nextAttemptNumber(projectId: string, sourceId: string): Promise<number>;
  createJob(input: CreateIngestionJobInput): Promise<IngestionJob>;
  markProcessing(jobId: string, at: string): Promise<void>;
  markCompleted(jobId: string, at: string): Promise<void>;
  markFailed(jobId: string, at: string, errorCode: string, errorMessage: string): Promise<void>;
  saveOutput(input: SaveIngestionOutputInput): Promise<IngestionOutput>;
  latestOutput(projectId: string, sourceId: string): Promise<IngestionOutput | null>;

  // ---- canonical documents (K12)
  /** Persists the document snapshot for one ingestion. Throws on failure. */
  saveDocuments(inputs: CreateDocumentInput[]): Promise<DocumentRecord[]>;
  /** Compensation: removes a partially written snapshot. */
  deleteDocumentsForJob(ingestionJobId: string): Promise<void>;
  /** Metadata-only listing (never selects normalized_text). */
  listDocumentSummaries(projectId: string, sourceId: string, ingestionJobId: string): Promise<DocumentSummary[]>;
  getDocument(projectId: string, documentId: string): Promise<DocumentRecord | null>;
  /** Resolves which snapshot a default listing should read. */
  latestCompletedJob(projectId: string, sourceId: string): Promise<IngestionJob | null>;

  // ---- canonical chunks (K13)
  /** Persists the chunk snapshot of one ingestion. Throws on failure. */
  saveChunks(inputs: CreateChunkInput[]): Promise<ChunkRecord[]>;
  /** Compensation: removes a partially written chunk snapshot. */
  deleteChunksForJob(ingestionJobId: string): Promise<void>;
  /** Chunk listing for one document: metadata + short preview, never the full body. */
  listChunkSummaries(projectId: string, documentId: string): Promise<ChunkSummary[]>;
  getChunk(projectId: string, chunkId: string): Promise<ChunkRecord | null>;
}

export interface IngestionSourceSummary {
  id: string;
  projectId: string;
  sourceType: SourceType;
  status: string;
  /** Registered origin for url sources (needed by the URL adapter). */
  externalUri?: string;
}

/** Raw material handed to an adapter. `bytes` is only populated for file artifacts. */
export interface RawMaterial {
  kind: 'text' | 'file';
  text?: string;
  bytes?: Uint8Array;
  mimeType?: string;
  originalName?: string;
}

export interface IngestionSourceReader {
  getSource(projectId: string, sourceId: string): Promise<IngestionSourceSummary | null>;
  /** Null when the source has no raw artifact (reported as RAW_ARTIFACT_MISSING). */
  readRawMaterial(projectId: string, sourceId: string): Promise<RawMaterial | null>;
}

/** One adapter per source type. Adding a source type means adding an adapter. */
export interface SourceAcquisitionAdapter {
  readonly sourceTypes: readonly SourceType[];
  acquire(input: { projectId: string; sourceId: string; sourceType: SourceType }): Promise<AcquiredContent>;
}
