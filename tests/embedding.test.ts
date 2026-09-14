/**
 * K14 embedding service: batching, deterministic reuse, dimension validation,
 * idempotency and provider-failure isolation (content must stay untouched).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EmbeddingService } from '../src/core/embedding/embedding.service.ts';
import { EmbeddingFailure, planBatches, EMBEDDING_DIMENSIONS } from '../src/core/embedding/embedding.ts';
import type {
  CreateEmbeddingInput,
  EmbeddableChunk,
  EmbeddingJob,
  EmbeddingJobSummary,
  EmbeddingPersistence,
} from '../src/core/embedding/embedding.ts';
import type { EmbedTextsInput, EmbedTextsOutput, ModelGateway } from '../src/core/model-gateway/model-gateway.ts';
import { MissingAssignmentError } from '../src/platform/provider/model-assignment.ts';

const vector = () => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);

function fakePersistence(chunks: EmbeddableChunk[]) {
  const jobs: EmbeddingJob[] = [];
  const rows: CreateEmbeddingInput[] = [];
  const state = {
    jobs,
    rows,
    savedBatches: [] as number[],
    activeJob: null as EmbeddingJob | null,
    alreadyEmbedded: [] as string[],
  };

  const persistence: EmbeddingPersistence = {
    async findActiveJob() {
      return state.activeJob;
    },
    async createJob(input) {
      const job: EmbeddingJob = {
        id: `job-${jobs.length + 1}`,
        projectId: input.projectId,
        sourceId: input.sourceId,
        ingestionJobId: input.ingestionJobId,
        status: 'queued',
        providerKey: input.providerKey,
        modelId: input.modelId,
        dimensions: input.dimensions,
        chunksRequested: 0,
        chunksEmbedded: 0,
        chunksReused: 0,
        batchCount: 0,
        createdAt: new Date().toISOString(),
      };
      jobs.push(job);
      return job;
    },
    async markProcessing(id) {
      const j = jobs.find((x) => x.id === id);
      if (j) j.status = 'processing';
    },
    async markCompleted(id, counters) {
      const j = jobs.find((x) => x.id === id);
      if (j) {
        Object.assign(j, counters, { status: 'completed', completedAt: new Date().toISOString() });
      }
    },
    async markFailed(id, code, message) {
      const j = jobs.find((x) => x.id === id);
      if (j) Object.assign(j, { status: 'failed', errorCode: code, errorMessage: message });
    },
    async chunksForIngestion() {
      return chunks;
    },
    async embeddedChunkIds() {
      return state.alreadyEmbedded;
    },
    async reusableVectors(_p, _prov, _model, shas) {
      const found = new Map<string, number[]>();
      for (const sha of shas) {
        const hit = rows.find((r) => r.chunkContentSha256 === sha);
        if (hit) found.set(sha, hit.vector);
      }
      return found;
    },
    async reusableVector(_p, _prov, _model, sha) {
      const hit = rows.find((r) => r.chunkContentSha256 === sha);
      return hit ? hit.vector : null;
    },
    async saveEmbeddings(inputs) {
      state.savedBatches.push(inputs.length);
      rows.push(...inputs);
      return inputs.length;
    },
    async countEmbeddings() {
      return rows.length;
    },
    async countChunks() {
      return chunks.length;
    },
    async latestJobForSource(): Promise<EmbeddingJobSummary | null> {
      return null;
    },
    async getJob() {
      return null;
    },
  };
  return { persistence, state };
}

function fakeGateway(impl?: (input: EmbedTextsInput) => Promise<EmbedTextsOutput>) {
  const calls: EmbedTextsInput[] = [];
  const gateway: ModelGateway = {
    async generateText() {
      return { text: '' };
    },
    async embedTexts(input) {
      calls.push(input);
      if (impl) return impl(input);
      return { vectors: input.texts.map(() => vector()), model: 'fake-embed', provider: 'openrouter' };
    },
  };
  return { gateway, calls };
}

const chunk = (n: number, sha?: string): EmbeddableChunk => ({
  chunkId: `c${n}`,
  documentId: 'd1',
  sourceId: 's1',
  chunkIndex: n,
  text: `text ${n}`,
  contentSha256: sha ?? `sha-${n}`,
});

const service = (
  chunks: EmbeddableChunk[],
  gateway: ModelGateway,
  resolverImpl: () => Promise<{ providerKey: string; modelId: string }>,
) => {
  const { persistence, state } = fakePersistence(chunks);
  const svc = new EmbeddingService({
    persistence,
    sources: { latestCompletedIngestion: async () => ({ id: 'ing-1' }) },
    resolver: { resolve: resolverImpl },
    gateway,
  });
  return { svc, state };
};

const assigned = async () => ({ providerKey: 'openrouter', modelId: 'google/gemini-embedding-001' });

describe('planBatches', () => {
  it('caps by count', () => {
    const batches = planBatches(Array.from({ length: 70 }, (_, i) => chunk(i)));
    assert.deepEqual(batches.map((b) => b.length), [32, 32, 6]);
  });

  it('caps by characters and keeps input order', () => {
    const big = (n: number): EmbeddableChunk => ({ ...chunk(n), text: 'x'.repeat(40_000) });
    const batches = planBatches([big(0), big(1), big(2)]);
    assert.deepEqual(batches.map((b) => b.length), [1, 1, 1]);
    assert.deepEqual(batches.map((b) => b[0].chunkId), ['c0', 'c1', 'c2']);
  });
});

describe('EmbeddingService', () => {
  it('embeds pending chunks and records counters', async () => {
    const { gateway, calls } = fakeGateway();
    const { svc, state } = service([chunk(0), chunk(1)], gateway, assigned);

    const result = await svc.indexKnowledge({ projectId: 'p1', sourceId: 's1', actor: 'actor-1' });

    assert.equal(result.job.status, 'completed');
    assert.equal(state.rows.length, 2);
    assert.equal(state.jobs[0].chunksEmbedded, 2);
    assert.equal(state.jobs[0].chunksReused, 0);
    assert.equal(calls.length, 1);
    assert.equal(state.rows[0].dimensions, EMBEDDING_DIMENSIONS);
    assert.equal(state.rows[0].vector.length, EMBEDDING_DIMENSIONS);
  });

  it('reuses identical content inside the same project without calling the provider twice', async () => {
    const { gateway, calls } = fakeGateway();
    // Same content hash => the second chunk must be reused from the first.
    const { svc, state } = service([chunk(0, 'same'), chunk(1, 'same')], gateway, assigned);

    await svc.indexKnowledge({ projectId: 'p1', sourceId: 's1', actor: 'a' });

    // One provider call, carrying only the FIRST chunk.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].texts, ['text 0']);
    assert.equal(state.jobs[0].chunksReused, 1);
    assert.equal(state.jobs[0].chunksEmbedded, 1);
    // A row is still written for BOTH chunks.
    assert.equal(state.rows.length, 2);
    assert.deepEqual(state.rows[0].vector, state.rows[1].vector);
  });

  it('fails on dimension drift and never persists a wrong-width vector', async () => {
    const { gateway } = fakeGateway(async (input) => ({
      vectors: input.texts.map(() => [0.1, 0.2, 0.3]),
      model: 'fake',
    }));
    const { svc, state } = service([chunk(0)], gateway, assigned);

    await assert.rejects(
      () => svc.indexKnowledge({ projectId: 'p1', sourceId: 's1', actor: 'a' }),
      (e: unknown) => e instanceof EmbeddingFailure && e.code === 'EMBEDDING_DIMENSION_MISMATCH',
    );
    assert.equal(state.rows.length, 0);
    assert.equal(state.jobs[0].status, 'failed');
    assert.equal(state.jobs[0].errorCode, 'EMBEDDING_DIMENSION_MISMATCH');
  });

  it('keeps content untouched when the provider fails', async () => {
    const { gateway } = fakeGateway(async () => {
      throw new Error('provider exploded');
    });
    const { svc, state } = service([chunk(0)], gateway, assigned);

    await assert.rejects(
      () => svc.indexKnowledge({ projectId: 'p1', sourceId: 's1', actor: 'a' }),
      (e: unknown) => e instanceof EmbeddingFailure && e.code === 'EMBEDDING_PROVIDER_FAILED',
    );
    assert.equal(state.jobs[0].status, 'failed');
    assert.equal(state.rows.length, 0);
    // The job exists (and is retryable) — nothing else was mutated.
    assert.equal(state.jobs.length, 1);
  });

  it('fails explicitly when no embeddings model is assigned', async () => {
    const { gateway, calls } = fakeGateway();
    const { svc, state } = service([chunk(0)], gateway, async () => {
      throw new MissingAssignmentError('embeddings');
    });

    await assert.rejects(
      () => svc.indexKnowledge({ projectId: 'p1', sourceId: 's1', actor: 'a' }),
      (e: unknown) => e instanceof EmbeddingFailure && e.code === 'EMBEDDING_ASSIGNMENT_MISSING',
    );
    assert.equal(calls.length, 0);
    assert.equal(state.jobs.length, 0);
  });

  it('reuses an active job instead of paying twice', async () => {
    const { gateway, calls } = fakeGateway();
    const { persistence, state } = fakePersistence([chunk(0)]);
    const active: EmbeddingJob = {
      id: 'job-active',
      projectId: 'p1',
      sourceId: 's1',
      ingestionJobId: 'ing-1',
      status: 'processing',
      providerKey: 'openrouter',
      modelId: 'google/gemini-embedding-001',
      dimensions: EMBEDDING_DIMENSIONS,
      chunksRequested: 1,
      chunksEmbedded: 0,
      chunksReused: 0,
      batchCount: 0,
      createdAt: new Date().toISOString(),
    };
    state.activeJob = active;
    const svc = new EmbeddingService({
      persistence,
      sources: { latestCompletedIngestion: async () => ({ id: 'ing-1' }) },
      resolver: { resolve: assigned },
      gateway,
    });

    const result = await svc.indexKnowledge({ projectId: 'p1', sourceId: 's1', actor: 'a' });
    assert.equal(result.reused, true);
    assert.equal(result.job.id, 'job-active');
    assert.equal(calls.length, 0);
    assert.equal(state.jobs.length, 0);
  });

  it('does not call the provider when every chunk is already indexed', async () => {
    const { gateway, calls } = fakeGateway();
    const { persistence, state } = fakePersistence([chunk(0), chunk(1)]);
    state.alreadyEmbedded = ['c0', 'c1'];
    const svc = new EmbeddingService({
      persistence,
      sources: { latestCompletedIngestion: async () => ({ id: 'ing-1' }) },
      resolver: { resolve: assigned },
      gateway,
    });

    const result = await svc.indexKnowledge({ projectId: 'p1', sourceId: 's1', actor: 'a' });
    assert.equal(result.reason, 'already_indexed');
    assert.equal(calls.length, 0);
    assert.equal(state.jobs[0].status, 'completed');
  });
});
