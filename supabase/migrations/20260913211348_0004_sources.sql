-- K0 Source Registry V1: project-scoped canonical knowledge-source registry.
-- V1 implemented source_type = 'url'. Other types are reserved vocabulary, not
-- accepted by the product/API until their pipeline (file storage, connectors) exists.
-- No storage_ref, no content/chunks/embeddings, no ingestion fields.

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  source_type text not null check (source_type in ('url')),
  title text not null,
  description text,
  external_uri text not null,
  status text not null default 'registered' check (status in ('registered', 'archived')),
  created_by_subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index sources_project_id_idx on public.sources (project_id);

alter table public.sources enable row level security;
