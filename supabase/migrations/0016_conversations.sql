-- K23 Conversation Foundation V1: ONE minimal generic session table.
--
-- Justification (required by the slice spec before adding a table): multi-turn
-- continuity and restart proof need DURABLE session state that is NOT the client's
-- transcript and NOT User Memory. Session-local facts supplied inside a conversation
-- must survive turns (and a backend restart) without becoming personal Memory.
--
-- Privacy: session_context holds ONLY session-local continuity (structured facts
-- supplied/resolved in THIS session, a pending requirement key and a bounded recent
-- turn list). It is explicitly SEPARATE from (and never merged into) memory_records.
-- A PRIVATE session's session_context is never promoted to personal Memory.

create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  actor_subject   text not null,
  mode            text not null check (mode in ('contextual', 'private')),
  status          text not null default 'active' check (status in ('active', 'closed')),
  session_context jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists conversations_scope
  on public.conversations (project_id, actor_subject, updated_at desc);

alter table public.conversations enable row level security;
-- No permissive policies: access is server-mediated (service role) only.
