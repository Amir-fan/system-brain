-- K0 Platform Foundation: project, project_memberships, runs
-- Applied only to the new KIP Next Supabase project.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  actor_subject text not null,
  role text not null check (role in ('owner', 'member', 'service')),
  created_at timestamptz not null default now(),
  constraint project_memberships_project_actor_unique unique (project_id, actor_subject)
);

create index project_memberships_actor_idx on public.project_memberships (actor_subject);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  actor_subject text,
  capability_key text not null,
  status text not null check (status in ('started', 'completed', 'failed')),
  provider_key text,
  model_name text,
  started_at timestamptz not null,
  completed_at timestamptz,
  latency_ms integer,
  error_category text check (error_category in ('validation', 'authorization', 'not_found', 'provider', 'runtime')),
  usage_tokens_prompt integer,
  usage_tokens_completion integer,
  usage_tokens_total integer,
  usage_cost_usd numeric(18, 6)
);

create index runs_project_id_idx on public.runs (project_id);