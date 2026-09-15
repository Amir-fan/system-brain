-- K18 Memory Foundation V1: one generic project-scoped memory table.
-- Memory is durable project-scoped context (REMEMBER/RECALL/SUPERSEDE/ARCHIVE/RELEVANT).
-- It is deliberately NOT domain-specific: payload is JSONB, scope/type/key are generic
-- labels. The engine never interprets payload semantics.

create table if not exists public.memory_records (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  scope         text not null check (scope in ('user', 'conversation', 'case')),
  subject_id    text not null,
  memory_type   text not null,
  memory_key    text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'active' check (status in ('active', 'superseded', 'archived')),
  provenance    jsonb not null default '{}'::jsonb,
  valid_from    timestamptz,
  superseded_by uuid references public.memory_records(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One current value per logical memory identity.
create unique index if not exists memory_records_active_key
  on public.memory_records (project_id, scope, subject_id, memory_type, memory_key)
  where status = 'active';

-- Deterministic relevant retrieval: project-scoped, recency-ordered.
create index if not exists memory_records_relevant
  on public.memory_records (project_id, scope, subject_id, status, updated_at desc);

alter table public.memory_records enable row level security;
-- No permissive policies: all access is server-mediated (service role).
