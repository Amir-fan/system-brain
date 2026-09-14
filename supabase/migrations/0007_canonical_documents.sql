-- K12 Canonical Document Model V1.
--
-- A Document is the canonical logical knowledge unit produced by a SUCCESSFUL
-- ingestion. It is NOT a source, a raw artifact, an ingestion job, or a chunk.
-- Documents belong to the ingestion_job that produced them, so history survives
-- re-ingestion; the "latest" view resolves at read time.
--
-- THIS FILE MIRRORS THE APPLIED MIGRATION (recorded as 0007_canonical_documents).
-- It includes the composite consistency constraints that are live in the database.

-- Parent keys that make the composite consistency FKs possible.
alter table public.sources add constraint sources_id_project_key unique (id, project_id);
alter table public.ingestion_jobs add constraint ingestion_jobs_id_source_key unique (id, source_id);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  source_id uuid not null references public.sources (id) on delete cascade,
  ingestion_job_id uuid not null references public.ingestion_jobs (id) on delete cascade,
  ingestion_output_id uuid references public.ingestion_outputs (id) on delete set null,
  -- Deterministic logical identity within one ingestion, e.g.
  --   text:primary | url:primary | file:<name> | github:<repo-relative-path>
  document_key text not null check (length(document_key) > 0),
  title text,
  logical_path text,
  content_type text not null check (content_type in ('text/plain')),
  normalized_text text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  char_count integer not null check (char_count >= 0),
  ordinal integer not null check (ordinal >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One logical unit per ingestion: a re-run creates a new job, never a clash.
  constraint documents_job_document_key unique (ingestion_job_id, document_key),
  -- Consistency: a document's source must belong to the document's project, and
  -- the referenced ingestion job must belong to the same source.
  constraint documents_source_project_fk foreign key (source_id, project_id)
    references public.sources (id, project_id) on delete cascade,
  constraint documents_job_source_fk foreign key (ingestion_job_id, source_id)
    references public.ingestion_jobs (id, source_id) on delete cascade
);

create index documents_project_source_idx on public.documents (project_id, source_id, ordinal);
create index documents_job_idx on public.documents (ingestion_job_id);
create index documents_source_created_idx on public.documents (source_id, created_at desc);

alter table public.documents enable row level security;
