/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-011
 * @purpose Supabase persistence + raw-material reader for the ingestion domain.
 *
 * Read-only with respect to the Source Registry: sources/raw_artifacts are only
 * read here, never written. The partial unique index on ingestion_jobs(source_id)
 * is what makes the single-active-job rule database-enforced.
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import type { RawStorage } from '../storage/raw-storage.ts';
import { ActiveIngestionJobExistsError } from '../../core/ingestion/ingestion.ports.ts';
import type {
  IngestionPersistence,
  IngestionSourceReader,
  IngestionSourceSummary,
  RawMaterial,
} from '../../core/ingestion/ingestion.ports.ts';
import type {
  CreateIngestionJobInput,
  IngestionErrorCode,
  IngestionJob,
  IngestionOutput,
  IngestionStatus,
  IngestionTrigger,
  SaveIngestionOutputInput,
} from '../../core/ingestion/ingestion.types.ts';
import type { SourceType } from '../../core/project/source-type.ts';
import type { CreateDocumentInput, DocumentRecord, DocumentSummary } from '../../core/ingestion/document.ts';

const JOB_COLUMNS =
  'id, project_id, source_id, status, attempt_number, trigger_type, started_at, completed_at, failed_at, error_code, error_message, created_by_subject, created_at, updated_at';

const DOC_COLUMNS =
  'id, project_id, source_id, ingestion_job_id, ingestion_output_id, document_key, title, logical_path, content_type, content_sha256, char_count, ordinal, created_at, updated_at';

/** List projection: deliberately excludes normalized_text. */
const DOC_SUMMARY_COLUMNS =
  'id, project_id, source_id, ingestion_job_id, ingestion_output_id, document_key, title, logical_path, content_type, content_sha256, char_count, ordinal, created_at, updated_at';

/** Single-document projection: includes the normalized text for inspection. */
const DOC_FULL_COLUMNS = DOC_COLUMNS + ', normalized_text';

const OUTPUT_COLUMNS =
  'id, project_id, ingestion_job_id, source_id, content_type, normalized_text, content_sha256, char_count, created_at';

const mapJob = (r: Record<string, unknown>): IngestionJob => ({
  id: r.id as string,
  projectId: r.project_id as string,
  sourceId: r.source_id as string,
  status: r.status as IngestionStatus,
  attemptNumber: Number(r.attempt_number ?? 1),
  triggerType: r.trigger_type as IngestionTrigger,
  startedAt: (r.started_at as string) ?? undefined,
  completedAt: (r.completed_at as string) ?? undefined,
  failedAt: (r.failed_at as string) ?? undefined,
  errorCode: (r.error_code as IngestionErrorCode) ?? undefined,
  errorMessage: (r.error_message as string) ?? undefined,
  createdBySubject: r.created_by_subject as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const mapDocument = (r: Record<string, unknown>): DocumentRecord => ({
  id: r.id as string,
  projectId: r.project_id as string,
  sourceId: r.source_id as string,
  ingestionJobId: r.ingestion_job_id as string,
  ingestionOutputId: (r.ingestion_output_id as string) ?? undefined,
  documentKey: r.document_key as string,
  title: (r.title as string) ?? undefined,
  logicalPath: (r.logical_path as string) ?? undefined,
  contentType: r.content_type as 'text/plain',
  normalizedText: (r.normalized_text as string) ?? '',
  contentSha256: r.content_sha256 as string,
  charCount: Number(r.char_count ?? 0),
  ordinal: Number(r.ordinal ?? 0),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

function summaryOf(doc: DocumentRecord): DocumentSummary {
  const { normalizedText, ...rest } = doc;
  void normalizedText;
  return rest;
}
const mapDocumentSummary = (r: Record<string, unknown>): DocumentSummary => summaryOf(mapDocument(r));

const mapOutput = (r: Record<string, unknown>): IngestionOutput => ({
  id: r.id as string,
  projectId: r.project_id as string,
  ingestionJobId: r.ingestion_job_id as string,
  sourceId: r.source_id as string,
  contentType: r.content_type as 'text/plain',
  normalizedText: r.normalized_text as string,
  contentSha256: r.content_sha256 as string,
  charCount: Number(r.char_count ?? 0),
  createdAt: r.created_at as string,
});

/** Supabase surfaces a unique violation as Postgres error code 23505. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === '23505' || (typeof e?.message === 'string' && e.message.includes('duplicate key'));
}

export function createIngestionPersistence(db: SupabaseDatabase): IngestionPersistence {
  const getJobById = async (projectId: string, jobId: string) => {
    const { data } = await db
      .from('ingestion_jobs')
      .select(JOB_COLUMNS)
      .eq('project_id', projectId)
      .eq('id', jobId)
      .maybeSingle();
    return data ? mapJob(data) : null;
  };

  const orderedJobs = async (projectId: string, sourceId?: string, limit = 200) => {
    let q = db.from('ingestion_jobs').select(JOB_COLUMNS).eq('project_id', projectId);
    if (sourceId) q = q.eq('source_id', sourceId);
    const { data } = await q.order('created_at', { ascending: false }).limit(limit);
    return (data ?? []).map(mapJob);
  };

  return {
    async findActiveJob(projectId, sourceId) {
      const { data } = await db
        .from('ingestion_jobs')
        .select(JOB_COLUMNS)
        .eq('project_id', projectId)
        .eq('source_id', sourceId)
        .in('status', ['queued', 'processing'])
        .maybeSingle();
      return data ? mapJob(data) : null;
    },
    getJob: getJobById,
    async latestJob(projectId, sourceId) {
      const jobs = await orderedJobs(projectId, sourceId, 1);
      return jobs[0] ?? null;
    },
    listJobs(projectId, sourceId) {
      return orderedJobs(projectId, sourceId);
    },
    async listLatestJobsByProject(projectId) {
      const jobs = await orderedJobs(projectId, undefined, 1000);
      const latest = new Map<string, IngestionJob>();
      for (const job of jobs) if (!latest.has(job.sourceId)) latest.set(job.sourceId, job);
      return [...latest.values()];
    },
    async nextAttemptNumber(projectId, sourceId) {
      const jobs = await orderedJobs(projectId, sourceId, 200);
      return jobs.reduce((max, j) => Math.max(max, j.attemptNumber), 0) + 1;
    },
    async createJob(input: CreateIngestionJobInput) {
      const row = {
        project_id: input.projectId,
        source_id: input.sourceId,
        status: 'queued',
        attempt_number: input.attemptNumber,
        trigger_type: input.triggerType,
        created_by_subject: input.createdBySubject,
      };
      const { data, error } = (await db.from('ingestion_jobs').insert(row).select(JOB_COLUMNS).maybeSingle()) as {
        data: Record<string, unknown> | null;
        error: unknown;
      };
      if (error) {
        if (isUniqueViolation(error)) throw new ActiveIngestionJobExistsError();
        throw new Error('ingestion job write failed');
      }
      if (!data) throw new Error('ingestion job write failed');
      return mapJob(data);
    },
    async markProcessing(jobId, at) {
      await db.from('ingestion_jobs').update({ status: 'processing', started_at: at, updated_at: at }).eq('id', jobId);
    },
    async markCompleted(jobId, at) {
      await db
        .from('ingestion_jobs')
        .update({ status: 'completed', completed_at: at, failed_at: null, error_code: null, error_message: null, updated_at: at })
        .eq('id', jobId);
    },
    async markFailed(jobId, at, errorCode, errorMessage) {
      await db
        .from('ingestion_jobs')
        .update({ status: 'failed', failed_at: at, error_code: errorCode, error_message: errorMessage, updated_at: at })
        .eq('id', jobId);
    },
    async saveOutput(input: SaveIngestionOutputInput) {
      const row = {
        project_id: input.projectId,
        ingestion_job_id: input.ingestionJobId,
        source_id: input.sourceId,
        content_type: 'text/plain',
        normalized_text: input.normalizedText,
        content_sha256: input.contentSha256,
        char_count: input.charCount,
      };
      const { data, error } = (await db
        .from('ingestion_outputs')
        .insert(row)
        .select(OUTPUT_COLUMNS)
        .maybeSingle()) as { data: Record<string, unknown> | null; error: unknown };
      if (error || !data) throw new Error('ingestion output write failed');
      return mapOutput(data);
    },
    async latestOutput(projectId, sourceId) {
      const { data } = await db
        .from('ingestion_outputs')
        .select(OUTPUT_COLUMNS)
        .eq('project_id', projectId)
        .eq('source_id', sourceId)
        .order('created_at', { ascending: false })
        .limit(1);
      const row = (data ?? [])[0];
      return row ? mapOutput(row) : null;
    },

    // ---- canonical documents (K12) ------------------------------------------
    async saveDocuments(inputs: CreateDocumentInput[]) {
      const rows = inputs.map((d) => ({
        project_id: d.projectId,
        source_id: d.sourceId,
        ingestion_job_id: d.ingestionJobId,
        ingestion_output_id: d.ingestionOutputId ?? null,
        document_key: d.documentKey,
        title: d.title ?? null,
        logical_path: d.logicalPath ?? null,
        content_type: 'text/plain',
        normalized_text: d.normalizedText,
        content_sha256: d.contentSha256,
        char_count: d.charCount,
        ordinal: d.ordinal,
      }));
      const { data, error } = (await db.from('documents').insert(rows).select(DOC_COLUMNS).limit(1000)) as {
        data: Array<Record<string, unknown>> | null;
        error: unknown;
      };
      if (error || !data || data.length === 0) throw new Error('document write failed');
      return data.map(mapDocument);
    },
    async deleteDocumentsForJob(ingestionJobId) {
      await db.from('documents').delete().eq('ingestion_job_id', ingestionJobId);
    },
    async listDocumentSummaries(projectId, sourceId, ingestionJobId) {
      const { data } = await db
        .from('documents')
        .select(DOC_SUMMARY_COLUMNS)
        .eq('project_id', projectId)
        .eq('source_id', sourceId)
        .eq('ingestion_job_id', ingestionJobId)
        .order('ordinal', { ascending: true })
        .limit(1000);
      return (data ?? []).map(mapDocumentSummary);
    },
    async getDocument(projectId, documentId) {
      const { data } = await db
        .from('documents')
        .select(DOC_FULL_COLUMNS)
        .eq('project_id', projectId)
        .eq('id', documentId)
        .maybeSingle();
      return data ? mapDocument(data) : null;
    },
    async latestCompletedJob(projectId, sourceId) {
      const { data } = await db
        .from('ingestion_jobs')
        .select(JOB_COLUMNS)
        .eq('project_id', projectId)
        .eq('source_id', sourceId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1);
      const row = (data ?? [])[0];
      return row ? mapJob(row) : null;
    },
  };
}

/** Reads sources + their original material. Never writes either. */
export function createIngestionSourceReader(db: SupabaseDatabase, rawStorage: RawStorage): IngestionSourceReader {
  return {
    async getSource(projectId, sourceId): Promise<IngestionSourceSummary | null> {
      const { data } = await db
        .from('sources')
        .select('id, project_id, source_type, status, external_uri')
        .eq('project_id', projectId)
        .eq('id', sourceId)
        .maybeSingle();
      if (!data) return null;
      return {
        id: data.id as string,
        projectId: data.project_id as string,
        sourceType: data.source_type as SourceType,
        status: data.status as string,
        externalUri: (data.external_uri as string) ?? undefined,
      };
    },
    async readRawMaterial(projectId, sourceId): Promise<RawMaterial | null> {
      const { data } = await db
        .from('raw_artifacts')
        .select('kind, mime_type, original_name, storage_path, text_content')
        .eq('project_id', projectId)
        .eq('source_id', sourceId)
        .maybeSingle();
      if (!data) return null;

      if (data.kind === 'text') {
        return { kind: 'text', text: (data.text_content as string) ?? '' };
      }
      const path = (data.storage_path as string) ?? '';
      if (!path) return null;
      const bytes = await rawStorage.read(path);
      return {
        kind: 'file',
        bytes,
        mimeType: (data.mime_type as string) ?? undefined,
        originalName: (data.original_name as string) ?? undefined,
      };
    },
  };
}
