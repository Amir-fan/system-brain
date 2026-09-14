/**
 * @kip
 * @module embedding
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-003
 * @purpose Canonical embedding contracts: the INDEX_READY side of knowledge.
 *
 * CONTENT_READY (ingestion -> documents -> chunks) is unchanged and never depends
 * on an external embedding provider. INDEX_READY is a separate, idempotent stage:
 * an embedding job embeds the chunks of ONE completed ingestion snapshot for ONE
 * model assignment. A provider outage fails the embedding job, never the content.
 *
 * An embedding is identified by the exact chunk + the exact chunk content hash +
 * the exact model. Reuse happens ONLY inside the same project: a global cache
 * would let one project infer that another project holds identical content.
 */

export const EMBEDDING_PROVIDER = 'openrouter';
/** Approved V1 model. The pgvector column is fixed at this width. */
export const EMBEDDING_MODEL_ID = 'google/gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 1536;

/** Bounded, deterministic batching. */
export const EMBEDDING_BATCH_SIZE = 32;
export const EMBEDDING_BATCH_MAX_CHARS = 60_000;
/** Transient-only retries: never on 400/401/402/403/404/413. */
export const EMBEDDING_MAX_RETRIES = 2;
export const EMBEDDING_RETRY_BACKOFF_MS = [1_000, 3_000] as const;
/** Statuses worth retrying (plus network timeouts, handled at the adapter). */
export const EMBEDDING_RETRYABLE_STATUS = [429, 500, 502, 503, 524, 529] as const;

export type EmbeddingErrorCode =
  | 'EMBEDDING_ASSIGNMENT_MISSING'
  | 'EMBEDDING_PROVIDER_FAILED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_PERSISTENCE_FAILED'
  | 'EMBEDDING_NOTHING_TO_INDEX';

export const EMBEDDING_ERROR_MESSAGES: Record<EmbeddingErrorCode, string> = {
  EMBEDDING_ASSIGNMENT_MISSING: 'لا يوجد نموذج فهرسة معيّن.',
  EMBEDDING_PROVIDER_FAILED: 'تعذر تجهيز الفهرسة من مزوّد النموذج.',
  EMBEDDING_DIMENSION_MISMATCH: 'أبعاد المتجهات غير متوافقة مع نموذج الفهرسة.',
  EMBEDDING_PERSISTENCE_FAILED: 'تعذر حفظ بيانات الفهرسة.',
  EMBEDDING_NOTHING_TO_INDEX: 'لا يوجد محتوى جاهز للفهرسة.',
};

export class EmbeddingFailure extends Error {
  readonly code: EmbeddingErrorCode;
  constructor(code: EmbeddingErrorCode, detail?: string) {
    super(EMBEDDING_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'EmbeddingFailure';
    if (detail) this.stack = `${this.stack ?? ''}\n[cause] ${detail}`;
  }
}

export type EmbeddingJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface EmbeddingJob {
  id: string;
  projectId: string;
  sourceId: string;
  ingestionJobId: string;
  status: EmbeddingJobStatus;
  providerKey: string;
  modelId: string;
  dimensions: number;
  chunksRequested: number;
  chunksEmbedded: number;
  chunksReused: number;
  inputTokens?: number;
  batchCount: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface EmbeddingRecord {
  id: string;
  projectId: string;
  chunkId: string;
  documentId: string;
  sourceId: string;
  ingestionJobId: string;
  embeddingJobId: string;
  modelProvider: string;
  modelId: string;
  dimensions: number;
  chunkContentSha256: string;
  createdAt: string;
}

export interface CreateEmbeddingInput {
  projectId: string;
  chunkId: string;
  documentId: string;
  sourceId: string;
  ingestionJobId: string;
  embeddingJobId: string;
  modelProvider: string;
  modelId: string;
  dimensions: number;
  vector: number[];
  chunkContentSha256: string;
}

/** A chunk to embed: the unit of work, with the hash that identifies its content. */
export interface EmbeddableChunk {
  chunkId: string;
  documentId: string;
  sourceId: string;
  chunkIndex: number;
  text: string;
  contentSha256: string;
}

export interface EmbeddingJobSummary {
  id: string;
  sourceId: string;
  ingestionJobId: string;
  status: EmbeddingJobStatus;
  modelId: string;
  dimensions: number;
  chunksRequested: number;
  chunksEmbedded: number;
  chunksReused: number;
  inputTokens?: number;
  batchCount: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface EmbeddingPersistence {
  /** The active (queued|processing) job for this snapshot + model, if any. */
  findActiveJob(projectId: string, ingestionJobId: string, modelId: string): Promise<EmbeddingJob | null>;
  createJob(input: {
    projectId: string;
    sourceId: string;
    ingestionJobId: string;
    providerKey: string;
    modelId: string;
    dimensions: number;
    createdBySubject: string;
  }): Promise<EmbeddingJob>;
  markProcessing(jobId: string): Promise<void>;
  markCompleted(jobId: string, counters: {
    chunksRequested: number;
    chunksEmbedded: number;
    chunksReused: number;
    inputTokens?: number;
    batchCount: number;
  }): Promise<void>;
  markFailed(jobId: string, code: string, message: string): Promise<void>;

  /** Chunks of one ingestion snapshot, ordered deterministically. */
  chunksForIngestion(projectId: string, ingestionJobId: string): Promise<EmbeddableChunk[]>;
  /** Chunk ids of that snapshot that ALREADY have a current embedding for the model. */
  embeddedChunkIds(projectId: string, ingestionJobId: string, modelId: string): Promise<string[]>;
  /** Project-scoped reuse lookup for many hashes at once (one round trip per batch). */
  reusableVectors(projectId: string, provider: string, modelId: string, contentSha256s: string[]): Promise<Map<string, number[]>>;
  /** Project-scoped reuse lookup: same project + provider + model + content hash. */
  reusableVector(projectId: string, provider: string, modelId: string, contentSha256: string): Promise<number[] | null>;
  saveEmbeddings(inputs: CreateEmbeddingInput[]): Promise<number>;
  /** Count of current embeddings for one snapshot + model (readiness arithmetic). */
  countEmbeddings(projectId: string, ingestionJobId: string, modelId: string): Promise<number>;
  /** Count of chunks in one snapshot (readiness arithmetic). */
  countChunks(projectId: string, ingestionJobId: string): Promise<number>;

  latestJobForSource(projectId: string, sourceId: string): Promise<EmbeddingJobSummary | null>;
  getJob(projectId: string, jobId: string): Promise<EmbeddingJobSummary | null>;
}

export interface EmbeddingRunResult {
  job: EmbeddingJob;
  reused: boolean;
  reason?: string;
}

/** Deterministic batch planning: never more than N chunks nor M characters. */
export function planBatches(
  chunks: EmbeddableChunk[],
  maxCount: number = EMBEDDING_BATCH_SIZE,
  maxChars: number = EMBEDDING_BATCH_MAX_CHARS,
): EmbeddableChunk[][] {
  const batches: EmbeddableChunk[][] = [];
  let current: EmbeddableChunk[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    const size = chunk.text.length;
    const wouldOverflow = current.length > 0 && (current.length + 1 > maxCount || chars + size > maxChars);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(chunk);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
