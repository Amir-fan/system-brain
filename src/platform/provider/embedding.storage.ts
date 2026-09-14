/**
 * @kip
 * @module provider
 * @layer platform
 * @owner platform-infra
 * @feature K1-003
 * @purpose Supabase persistence for embedding jobs + chunk embeddings (pgvector).
 *
 * Vectors are stored as pgvector literals ('[0.1,0.2,...]') and parsed back on
 * read. Embedding bodies are never logged and never returned to a browser.
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import type {
  CreateEmbeddingInput,
  EmbeddableChunk,
  EmbeddingJob,
  EmbeddingJobSummary,
  EmbeddingJobStatus,
  EmbeddingPersistence,
} from '../../core/embedding/embedding.ts';

const JOB_COLUMNS =
  'id, project_id, source_id, ingestion_job_id, status, provider_key, model_id, dimensions, chunks_requested, chunks_embedded, chunks_reused, input_tokens, batch_count, started_at, completed_at, failed_at, error_code, error_message, created_at';

const mapJob = (r: Record<string, unknown>): EmbeddingJob => ({
  id: r.id as string,
  projectId: r.project_id as string,
  sourceId: r.source_id as string,
  ingestionJobId: r.ingestion_job_id as string,
  status: r.status as EmbeddingJobStatus,
  providerKey: r.provider_key as string,
  modelId: r.model_id as string,
  dimensions: Number(r.dimensions ?? 0),
  chunksRequested: Number(r.chunks_requested ?? 0),
  chunksEmbedded: Number(r.chunks_embedded ?? 0),
  chunksReused: Number(r.chunks_reused ?? 0),
  inputTokens: r.input_tokens === null || r.input_tokens === undefined ? undefined : Number(r.input_tokens),
  batchCount: Number(r.batch_count ?? 0),
  startedAt: (r.started_at as string) ?? undefined,
  completedAt: (r.completed_at as string) ?? undefined,
  failedAt: (r.failed_at as string) ?? undefined,
  errorCode: (r.error_code as string) ?? undefined,
  errorMessage: (r.error_message as string) ?? undefined,
  createdAt: r.created_at as string,
});

const mapSummary = (r: Record<string, unknown>): EmbeddingJobSummary => {
  const job = mapJob(r);
  const { projectId: _projectId, providerKey: _providerKey, ...rest } = job;
  return { ...rest, sourceId: job.sourceId };
};

/** pgvector literal <-> number[] */
const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;
const parseVector = (raw: unknown): number[] | null => {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    return null;
  }
};

export function createEmbeddingPersistence(db: SupabaseDatabase): EmbeddingPersistence {
  return {
    async findActiveJob(projectId, ingestionJobId, modelId) {
      const { data } = await db
        .from('embedding_jobs')
        .select(JOB_COLUMNS)
        .eq('project_id', projectId)
        .eq('ingestion_job_id', ingestionJobId)
        .eq('model_id', modelId)
        .in('status', ['queued', 'processing'])
        .limit(1);
      const row = (data ?? [])[0];
      return row ? mapJob(row as Record<string, unknown>) : null;
    },

    async createJob(input) {
      const { data } = await db
        .from('embedding_jobs')
        .insert({
          project_id: input.projectId,
          source_id: input.sourceId,
          ingestion_job_id: input.ingestionJobId,
          status: 'queued',
          provider_key: input.providerKey,
          model_id: input.modelId,
          dimensions: input.dimensions,
          created_by_subject: input.createdBySubject,
        })
        .select(JOB_COLUMNS)
        .limit(1);
      const row = (data ?? [])[0];
      if (!row) throw new Error('embedding job write failed');
      return mapJob(row as Record<string, unknown>);
    },

    async markProcessing(jobId) {
      await db
        .from('embedding_jobs')
        .update({ status: 'processing', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('status', 'queued');
    },

    async markCompleted(jobId, counters) {
      await db
        .from('embedding_jobs')
        .update({
          status: 'completed',
          chunks_requested: counters.chunksRequested,
          chunks_embedded: counters.chunksEmbedded,
          chunks_reused: counters.chunksReused,
          input_tokens: counters.inputTokens ?? null,
          batch_count: counters.batchCount,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    },

    async markFailed(jobId, code, message) {
      await db
        .from('embedding_jobs')
        .update({
          status: 'failed',
          error_code: code,
          error_message: message,
          failed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    },

    async chunksForIngestion(projectId, ingestionJobId) {
      const { data } = await db
        .from('document_chunks')
        .select('id, document_id, source_id, chunk_index, text_content, content_sha256')
        .eq('project_id', projectId)
        .eq('ingestion_job_id', ingestionJobId)
        .order('document_id', { ascending: true })
        .order('chunk_index', { ascending: true })
        .limit(5000);
      return (data ?? []).map((r): EmbeddableChunk => ({
        chunkId: r.id as string,
        documentId: r.document_id as string,
        sourceId: r.source_id as string,
        chunkIndex: Number(r.chunk_index ?? 0),
        text: (r.text_content as string) ?? '',
        contentSha256: r.content_sha256 as string,
      }));
    },

    async embeddedChunkIds(projectId, ingestionJobId, modelId) {
      const { data } = await db
        .from('chunk_embeddings')
        .select('chunk_id')
        .eq('project_id', projectId)
        .eq('ingestion_job_id', ingestionJobId)
        .eq('model_id', modelId)
        .limit(5000);
      return (data ?? []).map((r) => r.chunk_id as string);
    },

    async reusableVectors(projectId, provider, modelId, contentSha256s) {
      const found = new Map<string, number[]>();
      if (contentSha256s.length === 0) return found;
      // One query per batch instead of one per chunk: the previous shape cost a
      // round trip for every chunk, which dominated a fully-reused reindex.
      const { data } = await db
        .from('chunk_embeddings')
        .select('embedding, chunk_content_sha256')
        .eq('project_id', projectId)
        .eq('model_provider', provider)
        .eq('model_id', modelId)
        .in('chunk_content_sha256', contentSha256s)
        .limit(5000);
      for (const row of data ?? []) {
        const r = row as Record<string, unknown>;
        const sha = r.chunk_content_sha256 as string;
        if (found.has(sha)) continue;
        const vector = parseVector(r.embedding);
        if (vector) found.set(sha, vector);
      }
      return found;
    },

    async reusableVector(projectId, provider, modelId, contentSha256) {
      // Same project only: a global lookup would leak cross-project existence.
      const { data } = await db
        .from('chunk_embeddings')
        .select('embedding')
        .eq('project_id', projectId)
        .eq('model_provider', provider)
        .eq('model_id', modelId)
        .eq('chunk_content_sha256', contentSha256)
        .limit(1);
      const row = (data ?? [])[0];
      return row ? parseVector((row as Record<string, unknown>).embedding) : null;
    },

    async saveEmbeddings(inputs: CreateEmbeddingInput[]) {
      if (inputs.length === 0) return 0;
      const rows = inputs.map((i) => ({
        project_id: i.projectId,
        chunk_id: i.chunkId,
        document_id: i.documentId,
        source_id: i.sourceId,
        ingestion_job_id: i.ingestionJobId,
        embedding_job_id: i.embeddingJobId,
        model_provider: i.modelProvider,
        model_id: i.modelId,
        dimensions: i.dimensions,
        embedding: toVectorLiteral(i.vector),
        chunk_content_sha256: i.chunkContentSha256,
      }));
      const { error } = (await db.from('chunk_embeddings').insert(rows)) as unknown as { error: unknown };
      if (error) throw new Error('embedding write failed');
      return rows.length;
    },

    async countEmbeddings(projectId, ingestionJobId, modelId) {
      const { data } = await db
        .from('chunk_embeddings')
        .select('id')
        .eq('project_id', projectId)
        .eq('ingestion_job_id', ingestionJobId)
        .eq('model_id', modelId)
        .limit(5000);
      return (data ?? []).length;
    },

    async countChunks(projectId, ingestionJobId) {
      const { data } = await db
        .from('document_chunks')
        .select('id')
        .eq('project_id', projectId)
        .eq('ingestion_job_id', ingestionJobId)
        .limit(5000);
      return (data ?? []).length;
    },

    async latestJobForSource(projectId, sourceId) {
      const { data } = await db
        .from('embedding_jobs')
        .select(JOB_COLUMNS)
        .eq('project_id', projectId)
        .eq('source_id', sourceId)
        .order('created_at', { ascending: false })
        .limit(1);
      const row = (data ?? [])[0];
      return row ? mapSummary(row as Record<string, unknown>) : null;
    },

    async getJob(projectId, jobId) {
      const { data } = await db
        .from('embedding_jobs')
        .select(JOB_COLUMNS)
        .eq('project_id', projectId)
        .eq('id', jobId)
        .maybeSingle();
      return data ? mapSummary(data as Record<string, unknown>) : null;
    },
  };
}
