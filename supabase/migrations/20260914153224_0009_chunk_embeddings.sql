-- K14 Embeddings + Vector Index V1.
--
-- Two concepts, deliberately separate:
--   CONTENT_READY = ingestion completed (documents + chunks persisted). Unchanged.
--   INDEX_READY   = the latest completed embedding job covers every chunk of the
--                   latest completed ingestion snapshot for the assigned model.
--
-- An embedding is tied to the EXACT chunk, the EXACT chunk content hash and the
-- EXACT embedding model, so staleness is detectable per row and re-embedding is
-- only ever explicit. No metadata JSON anywhere.
--
-- Model/dimension policy for V1: one locked pair (provider openrouter,
-- model google/gemini-embedding-001, dimensions 1536). pgvector columns are
-- fixed-width, so a different dimension is a migration + explicit reindex, never
-- a silent rebuild. Verified live: this model returns 1536-wide vectors.

create extension if not exists vector;

-- Parent keys required by the composite consistency FKs below.
alter table public.document_chunks add constraint document_chunks_id_project_key unique (id, project_id);
alter table public.document_chunks add constraint document_chunks_id_document_key unique (id, document_id);
alter table public.document_chunks add constraint document_chunks_id_source_key unique (id, source_id);

-- ---------------------------------------------------------------- A. embedding_jobs
create table public.embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  source_id uuid not null,
  ingestion_job_id uuid not null,
  status text not null check (status in ('queued', 'processing', 'completed', 'failed')),
  provider_key text not null check (provider_key = 'openrouter'),
  model_id text not null check (length(model_id) > 0),
  dimensions integer not null check (dimensions = 1536),
  chunks_requested integer not null default 0 check (chunks_requested >= 0),
  chunks_embedded integer not null default 0 check (chunks_embedded >= 0),
  chunks_reused integer not null default 0 check (chunks_reused >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  batch_count integer not null default 0 check (batch_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  created_by_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- State/timestamp relationships: a job cannot claim a stage it never entered,
  -- and a completed job can never carry an error.
  constraint embedding_jobs_state_ts check (
    (status = 'queued'     and started_at is null     and completed_at is null     and failed_at is null and error_code is null) or
    (status = 'processing' and started_at is not null and completed_at is null     and failed_at is null and error_code is null) or
    (status = 'completed'  and started_at is not null and completed_at is not null and failed_at is null and error_code is null) or
    (status = 'failed'     and started_at is not null and failed_at is not null    and completed_at is null and error_code is not null)
  ),
  -- The job must belong to the source's ingestion of the same project.
  constraint embedding_jobs_source_project_fk foreign key (source_id, project_id)
    references public.sources (id, project_id) on delete cascade,
  constraint embedding_jobs_ingestion_source_fk foreign key (ingestion_job_id, source_id)
    references public.ingestion_jobs (id, source_id) on delete cascade
);

-- At most ONE active job per ingestion snapshot + model: a double trigger reuses
-- the active job instead of paying for concurrent work.
create unique index embedding_jobs_active_unique
  on public.embedding_jobs (ingestion_job_id, model_id)
  where status in ('queued', 'processing');
create index embedding_jobs_source_idx on public.embedding_jobs (project_id, source_id, created_at desc);
create index embedding_jobs_status_idx on public.embedding_jobs (project_id, status);

alter table public.embedding_jobs enable row level security;

-- ---------------------------------------------------------------- B. chunk_embeddings
create table public.chunk_embeddings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  chunk_id uuid not null references public.document_chunks (id) on delete cascade,
  document_id uuid not null,
  source_id uuid not null,
  ingestion_job_id uuid not null,
  embedding_job_id uuid not null references public.embedding_jobs (id) on delete cascade,
  model_provider text not null check (model_provider = 'openrouter'),
  model_id text not null check (length(model_id) > 0),
  dimensions integer not null check (dimensions = 1536),
  embedding vector(1536) not null,
  -- The chunk content this vector was computed from: reuse and staleness both key off it.
  chunk_content_sha256 text not null check (chunk_content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  -- One current embedding per chunk per model. A model change adds rows, it never
  -- overwrites another model's vectors.
  constraint chunk_embeddings_chunk_model_key unique (chunk_id, model_provider, model_id),
  constraint chunk_embeddings_dims_match check (vector_dims(embedding) = dimensions),
  -- Exact chunk/project/document/source consistency (a chunk cannot be reported
  -- under a project, document or source it does not belong to).
  constraint chunk_embeddings_chunk_project_fk foreign key (chunk_id, project_id)
    references public.document_chunks (id, project_id) on delete cascade,
  constraint chunk_embeddings_chunk_document_fk foreign key (chunk_id, document_id)
    references public.document_chunks (id, document_id) on delete cascade,
  constraint chunk_embeddings_chunk_source_fk foreign key (chunk_id, source_id)
    references public.document_chunks (id, source_id) on delete cascade
);

-- Project-scoped reuse lookup: same project + model + content hash.
create index chunk_embeddings_reuse_idx
  on public.chunk_embeddings (project_id, model_provider, model_id, chunk_content_sha256);
create index chunk_embeddings_job_idx on public.chunk_embeddings (embedding_job_id);
create index chunk_embeddings_document_idx on public.chunk_embeddings (project_id, document_id);
create index chunk_embeddings_source_idx on public.chunk_embeddings (project_id, source_id);

-- HNSW + cosine (no IVFFlat): no training step, good recall, and incremental
-- inserts stay cheap as knowledge grows.
create index chunk_embeddings_vector_idx
  on public.chunk_embeddings using hnsw (embedding vector_cosine_ops);

alter table public.chunk_embeddings enable row level security;
