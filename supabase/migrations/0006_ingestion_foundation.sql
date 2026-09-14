-- K10 Ingestion Foundation V1 — project-scoped ingestion lifecycle.
--
-- Ownership: Source Registry owns source identity/configuration; Ingestion owns
-- processing lifecycle. This migration therefore adds NEW tables only and never
-- touches sources/raw_artifacts (raw_artifacts stays strictly raw/original).
--
-- Review of the required conditions:
--  1. No second knowledge system ... reuses sources + raw_artifacts; adds lifecycle only.
--  2. Raw artifact untouched ....... raw_artifacts is never written here; normalized text
--                                    lives in ingestion_outputs (derived + replaceable).
--  3. No JSON dumping .............. all state is explicit typed columns; zero json/jsonb.
--  4. Project isolation ............ project_id NOT NULL + FK RESTRICT on both tables.
--  5. Concurrency guard DB-enforced . partial UNIQUE index: one active job per source.
--  6. Explicit terminal states ..... CHECK constraint ties timestamps/errors to status.
--  7. No premature Document model .. `ingestion_outputs`, deliberately not `documents`.
--  8. No fake progress ............. only queued|processing|completed|failed; no percentages.
--  9. Change detection foundation .. content_sha256 (64-hex) persisted per output.
-- 10. RLS deny-by-default ......... enabled on both, no policies (server-mediated access).

create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  source_id uuid not null references public.sources (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  attempt_number integer not null default 1 check (attempt_number >= 1),
  trigger_type text not null default 'manual' check (trigger_type in ('manual', 'retry')),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  created_by_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Timestamps and errors must match the status: no half-written lifecycle rows.
  constraint ingestion_jobs_state_shape_check check (
    (status = 'queued' and started_at is null and completed_at is null and failed_at is null and error_code is null)
    or (status = 'processing' and started_at is not null and completed_at is null and failed_at is null)
    or (status = 'completed' and started_at is not null and completed_at is not null and failed_at is null and error_code is null)
    or (status = 'failed' and failed_at is not null and error_code is not null)
  )
);

-- At most ONE active job per source: repeated requests cannot create concurrent work.
create unique index ingestion_jobs_one_active_per_source_idx
  on public.ingestion_jobs (source_id)
  where status in ('queued', 'processing');

create index ingestion_jobs_project_created_idx on public.ingestion_jobs (project_id, created_at desc);
create index ingestion_jobs_source_created_idx on public.ingestion_jobs (source_id, created_at desc);
alter table public.ingestion_jobs enable row level security;

-- Normalized, derived output. NOT the canonical Document model (a later slice).
create table public.ingestion_outputs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  ingestion_job_id uuid not null unique references public.ingestion_jobs (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  content_type text not null check (content_type in ('text/plain')),
  normalized_text text not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  char_count integer not null check (char_count >= 0),
  created_at timestamptz not null default now()
);

create index ingestion_outputs_project_source_idx on public.ingestion_outputs (project_id, source_id, created_at desc);
alter table public.ingestion_outputs enable row level security;
