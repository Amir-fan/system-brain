-- K24 Intelligence Test Console: ONE tiny generic admin evaluation table.
--
-- Justification: after re-inspecting existing persistence (conversations, memory_records,
-- runs, ingestion) there is no semantically clean existing location for a one-off human
-- evaluation of a test conversation. session_context is session-local continuity, memory is
-- user knowledge, runs are execution traces. A tiny stand-alone evaluation record is the
-- smallest clean fit. It is NOT learning data and is never read back into memory or rules;
-- it is stored development evidence only.

create table if not exists public.evaluation_records (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  run_id           uuid references public.runs(id) on delete set null,
  tester_subject   text not null,
  is_correct       boolean not null,
  problem_category text,
  note             text,
  created_at       timestamptz not null default now(),
  constraint evaluation_records_category_check
    check (problem_category in ('understanding', 'clarification', 'context', 'source', 'result', 'wording', 'other'))
);

create index if not exists evaluation_records_project_tester_created
  on public.evaluation_records (project_id, tester_subject, created_at desc);

alter table public.evaluation_records enable row level security;
-- No permissive policies: access is server-mediated (service role) only.