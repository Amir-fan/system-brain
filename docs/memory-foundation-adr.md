# ADR-018 — Memory Foundation V1

Status: accepted
Slice: K18 Phase 1

## Decision
Introduce ONE generic, project-scoped Memory service over a single `memory_records`
table. Memory is a durable, project-scoped context store that other capabilities
(applications, skills, runtime) may read and write through the Memory Service. It is
NOT conversation-history storage, a scanner, a calendar/analytics/marketing engine,
an understanding engine, a skills runtime, or knowledge storage.

## Responsibilities (only)
- REMEMBER — persist a validated memory under (project, scope, subject).
- RECALL — return the active memory for a logical memory identity.
- SUPERSEDE — replace the current value safely; history is preserved.
- ARCHIVE — remove from normal recall without destroying history.
- RETRIEVE RELEVANT — return a small bounded set of active relevant memories.

## Model (minimum correct)
`memory_records(project_id, scope, subject_id, memory_type, memory_key, payload jsonb,
status, provenance jsonb, valid_from, superseded_by, created_at, updated_at)`.
- scope ∈ {user, conversation, case} — generic labels, not domain concepts.
- status ∈ {active, superseded, archived}.
- payload is JSONB; the engine never interprets it. No domain-specific columns.
- provenance is JSONB with a source hint (user/application/conversation/skill/system).
- A partial unique index on (project_id, scope, subject_id, memory_type, memory_key)
  WHERE status = 'active' guarantees a single current value per logical memory.

## Supersession (no overbuilt versioning)
Within one transaction: mark every currently ACTIVE record for the logical memory as
SUPERSEDED (superseded_by = new id), then insert the new ACTIVE record. Normal recall
returns only ACTIVE. History is available by explicit request.

## Isolation
Server-mediated only. Every handler authorizes via the canonical `authorizeProject`
boundary and passes the trusted project id to storage; SQL scopes every query by
`project_id`. No client-trusted ownership.

## Bounded context
`retrieveRelevant` never dumps memory. Deterministic filtering (project/scope/type/key,
recency) with a small explicit default limit (8) and a hard max (20). No embeddings,
no LLM selection, no reranking, no graph — re-evaluated only if a real acceptance
requirement proves deterministic retrieval insufficient.

## Memory != Learning Dataset (architectural reservation only)
Memory = individual/project contextual continuity. A future Learning Dataset = many
historical examples to improve models/skills via a gated lifecycle
(COLLECT → VALIDATE → LABEL → VERSION → TRAIN CANDIDATE → EVALUATE → PROMOTE → MONITOR).
Production models must NEVER silently self-modify from incoming user data. K18 Phase 1
adds NO learning tables, training pipeline, model registry, or scanner — this note
only establishes the boundary.
