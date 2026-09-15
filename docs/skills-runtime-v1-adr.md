# ADR-020 — Skills Runtime V1

Status: accepted
Slice: K20

## Decision
Introduce ONE general-purpose Skills Runtime that validates, resolves, authorizes
and executes a bounded named capability (a Skill) through KIP's EXISTING runtime
infrastructure. Skills are NOT prompts — they are executable contracts
(id, version, description, input/output schemas, declared requirements, execute).
The runtime is a thin layer over the existing Runtime/Run/Capability spine: skill
execution is exposed as a capability in the existing registry, so authorization,
Run creation/lifecycle and persistence are all reused (ZERO new tables).

Boundaries:
- CORE = generic platform execution primitives.
- KNOWLEDGE = evidence/information.
- MEMORY = durable contextual continuity.
- UNDERSTANDING = interpretation of the current input.
- SKILL = a bounded named capability that knows how to perform a specific task.
- SKILLS RUNTIME = validates/resolves/authorizes/executes a Skill via existing infra.
- LEARNING = future improvement loop (NOT Skills Runtime).
- NAQAA = future domain composition built ON TOP.

A Skill may declare requirements (understanding/memory/knowledge/model) and receives
ONLY what it declares — never the whole platform, never DB clients, never secrets,
never provider SDKs. Model access is only via the existing Model Gateway + Assignment
(never a direct provider call).

## Execution
request → authorize (existing boundary) → resolve Skill (code registry) → validate
input (invalid: no body execution, run failed) → resolve declared dependencies →
ambiguity gate (Skill requiring Understanding and status = NEEDS_CLARIFICATION does
NOT execute its body; returns a structured needs_clarification result) → execute body
→ validate output (invalid: safe failure, run failed) → structured SkillExecutionResult
{status: completed | needs_clarification | failed} → observability.

## Neutral proof skill
`demo.context-summary` (version 1): requirements understanding + memory, no model, no
knowledge. Deterministic, proves resolve/validate/understanding/memory/structured
output/ambiguity-gate. Not a production feature.

## Registry
Code-backed, in-process Map. register/get/list; stable identity + explicit version.
No marketplace, no dynamic code, no persistence, no editor/builder.

## Isolation
Server-mediated project authorization; bounded memory via the existing MemoryService
(never a dump, never cross-project). Understanding via the existing K19 service (never
reimplemented in the runtime). Knowledge (when declared) via existing K15/K16 only.
