-- K16: the `knowledge_answer` workload joins the assignment control plane.
--
-- Answering is its own workload because it has its own quality/cost profile
-- (grounded synthesis in Arabic and English) and must be assignable and
-- auditable independently of `embeddings` and `summarization`. No fallback
-- model: an unassigned workload fails explicitly.

alter table public.model_assignments
  drop constraint if exists model_assignments_workload_key_check;

alter table public.model_assignments
  add constraint model_assignments_workload_key_check
  check (workload_key = any (array[
    'source_analysis',
    'chat_assistant',
    'vision_scan',
    'summarization',
    'embeddings',
    'knowledge_answer'
  ]::text[]));
