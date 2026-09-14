/**
 * @kip
 * @module embedding
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-003
 * @purpose Embedding orchestration: chunks -> vectors -> pgvector, for ONE snapshot.
 *
 * INDEX_READY is produced here and nowhere else. Ingestion stays untouched: this
 * service consumes an already COMPLETED ingestion snapshot, so a provider outage,
 * a rate limit or a missing assignment can only fail the embedding job.
 *
 * Idempotent by construction:
 *   - an active job for the same snapshot + model is reused, never duplicated;
 *   - chunks that already have a current embedding for the model are skipped;
 *   - a chunk whose content hash already has a vector IN THE SAME PROJECT is
 *     reused instead of paying the provider again.
 */

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_ERROR_MESSAGES,
  EmbeddingFailure,
  planBatches,
} from './embedding.ts';
import type {
  CreateEmbeddingInput,
  EmbeddableChunk,
  EmbeddingJob,
  EmbeddingPersistence,
  EmbeddingRunResult,
} from './embedding.ts';
import type { ModelGateway } from '../model-gateway/model-gateway.ts';
import type { ModelAssignmentResolver } from '../../platform/provider/model-assignment.ts';

/** Narrow read port: the service only needs the latest completed ingestion. */
export interface IngestionSnapshotReader {
  latestCompletedIngestion(projectId: string, sourceId: string): Promise<{ id: string } | null>;
}

/** Safe structured observation. Never carries chunk text, vectors or credentials. */
export interface EmbeddingObservation {
  event: 'embedding.started' | 'embedding.completed' | 'embedding.failed' | 'embedding.reused';
  projectId: string;
  sourceId: string;
  jobId: string;
  ingestionJobId: string;
  providerKey?: string;
  modelId?: string;
  dimensions?: number;
  chunksRequested?: number;
  chunksEmbedded?: number;
  chunksReused?: number;
  batchCount?: number;
  inputTokens?: number;
  durationMs?: number;
  result: 'completed' | 'failed' | 'reused';
  errorCode?: string;
}

export interface EmbeddingServiceDeps {
  persistence: EmbeddingPersistence;
  sources: IngestionSnapshotReader;
  resolver: ModelAssignmentResolver;
  gateway: ModelGateway;
  onObservation?: (observation: EmbeddingObservation) => void;
}

export interface IndexKnowledgeInput {
  projectId: string;
  sourceId: string;
  actor: string;
}

export class EmbeddingService {
  constructor(private readonly deps: EmbeddingServiceDeps) {}

  /**
   * Trigger (or reuse) indexing for the latest completed ingestion of a source.
   * Explicit trigger only: nothing here is called from ingestion completion.
   */
  async indexKnowledge(input: IndexKnowledgeInput): Promise<EmbeddingRunResult> {
    const startedMs = Date.now();
    const { projectId, sourceId, actor } = input;

    // 1. Model assignment (control plane). No assignment => explicit failure, no fallback.
    let providerKey: string;
    let modelId: string;
    try {
      const resolved = await this.deps.resolver.resolve({ profile: 'embeddings' });
      providerKey = resolved.providerKey;
      modelId = resolved.modelId;
    } catch {
      throw new EmbeddingFailure('EMBEDDING_ASSIGNMENT_MISSING');
    }

    // 2. The snapshot to index.
    const snapshot = await this.deps.sources.latestCompletedIngestion(projectId, sourceId);
    if (!snapshot) throw new EmbeddingFailure('EMBEDDING_NOTHING_TO_INDEX');

    // 3. Idempotency: an in-flight job for this snapshot+model is reused.
    const active = await this.deps.persistence.findActiveJob(projectId, snapshot.id, modelId);
    if (active) {
      return { job: active, reused: true, reason: 'active_job' };
    }

    const chunks = await this.deps.persistence.chunksForIngestion(projectId, snapshot.id);
    if (chunks.length === 0) throw new EmbeddingFailure('EMBEDDING_NOTHING_TO_INDEX');

    const already = new Set(
      await this.deps.persistence.embeddedChunkIds(projectId, snapshot.id, modelId),
    );
    const pending = chunks.filter((c) => !already.has(c.chunkId));

    const job = await this.deps.persistence.createJob({
      projectId,
      sourceId,
      ingestionJobId: snapshot.id,
      providerKey,
      modelId,
      dimensions: EMBEDDING_DIMENSIONS,
      createdBySubject: actor,
    });
    await this.deps.persistence.markProcessing(job.id);

    this.deps.onObservation?.({
      event: 'embedding.started',
      projectId,
      sourceId,
      jobId: job.id,
      ingestionJobId: snapshot.id,
      providerKey,
      modelId,
      dimensions: EMBEDDING_DIMENSIONS,
      chunksRequested: pending.length,
      result: 'completed',
    });

    if (pending.length === 0) {
      // Everything already indexed for this model: nothing to pay for.
      const counters = { chunksRequested: 0, chunksEmbedded: 0, chunksReused: 0, batchCount: 0 };
      await this.deps.persistence.markCompleted(job.id, counters);
      this.deps.onObservation?.({
        event: 'embedding.reused',
        projectId,
        sourceId,
        jobId: job.id,
        ingestionJobId: snapshot.id,
        providerKey,
        modelId,
        dimensions: EMBEDDING_DIMENSIONS,
        chunksRequested: 0,
        chunksEmbedded: 0,
        chunksReused: 0,
        batchCount: 0,
        durationMs: Date.now() - startedMs,
        result: 'reused',
      });
      return { job: { ...job, status: 'completed', ...counters }, reused: true, reason: 'already_indexed' };
    }

    try {
      const outcome = await this.embedPending(pending, {
        projectId,
        sourceId,
        jobId: job.id,
        ingestionJobId: snapshot.id,
        providerKey,
        modelId,
      });

      await this.deps.persistence.markCompleted(job.id, {
        chunksRequested: pending.length,
        chunksEmbedded: outcome.embedded,
        chunksReused: outcome.reused,
        ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
        batchCount: outcome.batchCount,
      });

      this.deps.onObservation?.({
        event: 'embedding.completed',
        projectId,
        sourceId,
        jobId: job.id,
        ingestionJobId: snapshot.id,
        providerKey,
        modelId,
        dimensions: EMBEDDING_DIMENSIONS,
        chunksRequested: pending.length,
        chunksEmbedded: outcome.embedded,
        chunksReused: outcome.reused,
        batchCount: outcome.batchCount,
        ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
        durationMs: Date.now() - startedMs,
        result: 'completed',
      });

      return { job: { ...job, status: 'completed' }, reused: false };
    } catch (error) {
      const failure = error instanceof EmbeddingFailure ? error : new EmbeddingFailure('EMBEDDING_PROVIDER_FAILED');
      // Content is untouched: only the embedding job fails, and it stays retryable.
      await this.deps.persistence.markFailed(job.id, failure.code, EMBEDDING_ERROR_MESSAGES[failure.code]).catch(() => {});
      this.deps.onObservation?.({
        event: 'embedding.failed',
        projectId,
        sourceId,
        jobId: job.id,
        ingestionJobId: snapshot.id,
        providerKey,
        modelId,
        dimensions: EMBEDDING_DIMENSIONS,
        chunksRequested: pending.length,
        durationMs: Date.now() - startedMs,
        result: 'failed',
        errorCode: failure.code,
      });
      throw failure;
    }
  }

  /** Embed the pending chunks in bounded batches, reusing same-project vectors. */
  private async embedPending(
    pending: EmbeddableChunk[],
    ctx: {
      projectId: string;
      sourceId: string;
      jobId: string;
      ingestionJobId: string;
      providerKey: string;
      modelId: string;
    },
  ): Promise<{ embedded: number; reused: number; batchCount: number; inputTokens?: number }> {
    const inputs: CreateEmbeddingInput[] = [];
    let embedded = 0;
    let reused = 0;
    let batchCount = 0;
    let inputTokens: number | undefined;

    const base = {
      projectId: ctx.projectId,
      sourceId: ctx.sourceId,
      ingestionJobId: ctx.ingestionJobId,
      embeddingJobId: ctx.jobId,
      modelProvider: ctx.providerKey,
      modelId: ctx.modelId,
      dimensions: EMBEDDING_DIMENSIONS,
    };

    // Content already vectorised in THIS run. Without it, two identical chunks in
    // one job would be paid for twice; the reuse lookup alone only sees stored rows.
    const seen = new Map<string, number[]>();

    const takeReusable = async (chunk: EmbeddableChunk): Promise<number[] | null> =>
      seen.get(chunk.contentSha256) ?? null;

    for (const batch of planBatches(pending)) {
      const toEmbed: EmbeddableChunk[] = [];
      const deferred: EmbeddableChunk[] = [];

      // One project-scoped lookup per batch for everything not already resolved in
      // this run. Same project only: a global lookup would leak cross-project existence.
      const unknown = batch
        .map((c) => c.contentSha256)
        .filter((sha) => !seen.has(sha));
      if (unknown.length > 0) {
        const stored = await this.deps.persistence.reusableVectors(
          ctx.projectId,
          ctx.providerKey,
          ctx.modelId,
          [...new Set(unknown)],
        );
        for (const [sha, vector] of stored) seen.set(sha, vector);
      }

      for (const chunk of batch) {
        const reusable = await takeReusable(chunk);
        if (reusable) {
          // Same project only. A new row is still written for THIS chunk; nothing
          // reveals where the vector was first computed.
          inputs.push({
            ...base,
            chunkId: chunk.chunkId,
            documentId: chunk.documentId,
            vector: reusable,
            chunkContentSha256: chunk.contentSha256,
          });
          reused++;
          continue;
        }
        // Identical content already queued in THIS batch: never send it twice.
        if (toEmbed.some((c) => c.contentSha256 === chunk.contentSha256)) {
          deferred.push(chunk);
          continue;
        }
        toEmbed.push(chunk);
      }

      if (toEmbed.length > 0) {
        batchCount++;
        const out = await this.deps.gateway.embedTexts({
          projectId: ctx.projectId,
          runId: ctx.jobId,
          modelId: ctx.modelId,
          texts: toEmbed.map((c) => c.text),
          inputType: 'document',
          dimensions: EMBEDDING_DIMENSIONS,
        });

        if (out.vectors.length !== toEmbed.length) {
          throw new EmbeddingFailure('EMBEDDING_DIMENSION_MISMATCH', 'vector count mismatch');
        }
        for (const vector of out.vectors) {
          if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
            throw new EmbeddingFailure('EMBEDDING_DIMENSION_MISMATCH', 'unexpected vector width');
          }
        }
        if (out.usage?.totalTokens !== undefined) {
          inputTokens = (inputTokens ?? 0) + out.usage.totalTokens;
        }

        toEmbed.forEach((chunk, i) => {
          const vector = out.vectors[i];
          // Remember it for the rest of THIS run: identical content later in the same
          // job is written from this vector instead of being embedded again.
          seen.set(chunk.contentSha256, vector);
          inputs.push({
            ...base,
            chunkId: chunk.chunkId,
            documentId: chunk.documentId,
            vector,
            chunkContentSha256: chunk.contentSha256,
          });
        });
        embedded += toEmbed.length;
      }

      // Duplicates of content queued in this batch share the vector that was just
      // produced (or the one that was reused): one provider call per distinct text.
      for (const chunk of deferred) {
        const vector = seen.get(chunk.contentSha256);
        if (!vector) {
          throw new EmbeddingFailure('EMBEDDING_PROVIDER_FAILED', 'missing reused vector');
        }
        inputs.push({
          ...base,
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          vector,
          chunkContentSha256: chunk.contentSha256,
        });
        reused++;
      }
    }

    if (inputs.length > 0) {
      try {
        await this.deps.persistence.saveEmbeddings(inputs);
      } catch (error) {
        throw new EmbeddingFailure('EMBEDDING_PERSISTENCE_FAILED', String(error));
      }
    }
    return { embedded, reused, batchCount, ...(inputTokens !== undefined ? { inputTokens } : {}) };
  }
}

/** Derived INDEX_READY state: no separate mutable flag to drift out of sync. */
export type IndexReadiness = 'ready' | 'partial' | 'none' | 'indexing';

export function indexReadiness(input: {
  totalChunks: number;
  embeddedChunks: number;
  latestJobStatus?: 'queued' | 'processing' | 'completed' | 'failed';
  modelMatches: boolean;
}): IndexReadiness {
  if (input.latestJobStatus === 'queued' || input.latestJobStatus === 'processing') return 'indexing';
  if (input.totalChunks === 0) return 'none';
  if (input.modelMatches && input.embeddedChunks >= input.totalChunks) return 'ready';
  if (input.embeddedChunks > 0) return 'partial';
  return 'none';
}
