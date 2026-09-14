-- Knowledge Intake V1 — schema evolution (approved).
--
-- FINAL SCHEMA REVIEW (all ten required conditions):
--  1. No content duplication ............ one artifact per source (raw_artifacts.source_id UNIQUE);
--                                         one external reference per source (source_id UNIQUE).
--  2. No provider secrets stored here ... external_connections holds secure_secret_reference (a
--                                         Vault NAME) only; the secret value never lands in a table.
--  3. No unnecessary JSON metadata ...... all provider-neutral columns; zero json/jsonb columns.
--  4. Project ownership explicit ........ project_id NOT NULL on all three new tables (+ FK RESTRICT).
--  5. Unique constraints prevent dupes .. (project_id, provider) on connections;
--                                         (project_id, provider, external_item_id) on references.
--  6. FK delete behavior intentional .... artifacts/references follow the source (CASCADE);
--                                         connection revoke keeps identity (SET NULL on connection_id);
--                                         project deletes stay RESTRICT.
--  7. Existing URL sources remain valid . source_type check widened, external_uri made nullable,
--                                         no existing row touched or rewritten.
--  8. Archive semantics owned by registry  status stays registered|archived on sources; no new states.
--  9. Raw artifact is original only ...... kind file|text with a shape check; no parsed/derived text.
-- 10. Future concepts absent ............ no documents, chunks, embeddings, or ingestion fields.

-- 1) Source registry evolution -------------------------------------------------
alter table public.sources alter column external_uri drop not null;
alter table public.sources drop constraint sources_source_type_check;
alter table public.sources add constraint sources_source_type_check
  check (source_type in ('url', 'file', 'text', 'github', 'google_drive'));

-- 2) KIP-owned raw artifacts (original material only) --------------------------
create table public.raw_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  source_id uuid not null unique references public.sources (id) on delete cascade,
  kind text not null check (kind in ('file', 'text')),
  original_name text,
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  content_sha256 text,
  storage_bucket text,
  storage_path text,
  text_content text,
  created_at timestamptz not null default now(),
  -- A file artifact is storage-backed; a text artifact is content-backed. Never both.
  constraint raw_artifacts_shape_check check (
    (kind = 'file' and storage_bucket is not null and storage_path is not null and text_content is null)
    or
    (kind = 'text' and text_content is not null and storage_bucket is null and storage_path is null)
  )
);

create index raw_artifacts_project_id_idx on public.raw_artifacts (project_id);
alter table public.raw_artifacts enable row level security;

-- 3) External connections (provider-neutral; secret lives in Vault) ------------
create table public.external_connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  provider text not null check (provider in ('github', 'google_drive')),
  status text not null default 'not_connected' check (status in ('connected', 'not_connected', 'error')),
  external_account_id text,
  external_account_label text,
  secure_secret_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider)
);

create index external_connections_provider_idx on public.external_connections (provider);
alter table public.external_connections enable row level security;

-- 4) External source references (what a source points at, externally) ----------
create table public.external_source_references (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  source_id uuid not null unique references public.sources (id) on delete cascade,
  -- Revoking a connection must not corrupt historical source identity.
  connection_id uuid references public.external_connections (id) on delete set null,
  provider text not null check (provider in ('github', 'google_drive')),
  external_item_id text not null,
  external_type text not null,
  external_uri text,
  display_name text,
  external_path text,
  created_at timestamptz not null default now(),
  unique (project_id, provider, external_item_id)
);

create index external_source_references_project_id_idx on public.external_source_references (project_id, provider);
alter table public.external_source_references enable row level security;
