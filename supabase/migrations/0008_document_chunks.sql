-- K13 Chunking V1: canonical document chunks.
--
-- A Chunk is a deterministic, ordered segment of exactly ONE canonical Document.
-- It is not a source, artifact, job, document, or embedding. Chunks belong to the
-- document + ingestion snapshot that produced them, so re-ingestion creates a new
-- chunk set while history stays intact.
--
-- Conditions reviewed:
--  1. No duplication ................ references documents/sources/jobs directly.
--  2. Deterministic identity ....... unique (document_id, chunk_key) + (document_id, chunk_index).
--  3. Full coverage, no empties ... start_char/end_char explicit; char_count > 0 enforced.
--  4. No cross-document chunks ..... document_id is NOT NULL; composite FKs keep consistency.
--  5. Per-chunk hashing ............ content_sha256 computed from the stored chunk text.
--  6. No metadata JSON ............. explicit columns only.
--  7. No embeddings ................ zero vector/embedding concepts here.
--  8. RLS deny-by-default .......... enabled, zero policies (server-mediated).

-- Parent keys required by the composite consistency FKs.
alter table public.documents add constraint documents_id_source_key unique (id, source_id);
alter table public.documents add constraint documents_id_project_key unique (id, project_id);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  document_id uuid not null references public.documents (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  ingestion_job_id uuid not null references public.ingestion_jobs (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  -- <document_key>#<zero-padded index>, e.g. github:README.md#0000
  chunk_key text not null check (length(chunk_key) > 0),
  text_content text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  char_count integer not null check (char_count > 0),
  -- Exact span of the chunk inside the document's normalized text.
  start_char integer not null check (start_char >= 0),
  end_char integer not null check (end_char > start_char),
  heading_context text,
  logical_path text,
  created_at timestamptz not null default now(),
  constraint document_chunks_document_index unique (document_id, chunk_index),
  constraint document_chunks_document_key unique (document_id, chunk_key),
  constraint document_chunks_doc_source_fk foreign key (document_id, source_id)
    references public.documents (id, source_id) on delete cascade,
  constraint document_chunks_doc_project_fk foreign key (document_id, project_id)
    references public.documents (id, project_id) on delete cascade
);

create index document_chunks_document_idx on public.document_chunks (project_id, document_id, chunk_index);
create index document_chunks_job_idx on public.document_chunks (ingestion_job_id);
create index document_chunks_source_idx on public.document_chunks (source_id);

alter table public.document_chunks enable row level security;
