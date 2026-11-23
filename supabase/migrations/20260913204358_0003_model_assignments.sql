-- K0 Model Assignment V1: platform-level workload -> OpenRouter model mapping.
-- Pure control-plane assignment. No project_id, no skill_id, no per-user/env override.
-- The provider adapter never sees this table; ModelAssignmentResolver reads it.

create table public.model_assignments (
  id uuid primary key default gen_random_uuid(),
  workload_key text not null unique check (workload_key in (
    'source_analysis',
    'chat_assistant',
    'vision_scan',
    'summarization',
    'embeddings'
  )),
  provider_key text not null default 'openrouter' check (provider_key in ('openrouter')),
  model_id text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.model_assignments enable row level security;
