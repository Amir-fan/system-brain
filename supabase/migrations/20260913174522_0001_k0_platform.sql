-- K0 Platform Foundation: project, project_memberships, runs
-- Applied only to the new KIP Next Supabase project (ref wphpmwdjdsnpeiqsgbge).

-- RLS posture: deny-by-default for direct client/Data API access.
-- KIP Server authorization is the primary boundary; RLS is defense in depth.
-- No public/authenticated policies are created until a correct trusted
-- project-claim model exists. Direct client-to-database project access is
-- deliberately forbidden until such policies ship.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.projects enable row level security;

create table public.project_memberships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  actor_subject text not null,
  role text not null check (role in ('owner', 'member', 'service')),
  created_at timestamptz not null default now(),
  constraint project_memberships_project_actor_unique unique (project_id, actor_subject)
);

create index project_memberships_actor_idx on public.project_memberships (actor_subject);

alter table public.project_memberships enable row level security;

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
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

alter table public.runs enable row level security;

-- Delete behavior: runs and project_memberships use ON DELETE RESTRICT so a
-- project cannot be physically deleted while dependent run history or
-- memberships exist. The intended lifecycle is archive (status='archived'),
-- preserving run history for traceability, debugging, usage, cost, and forensics.
