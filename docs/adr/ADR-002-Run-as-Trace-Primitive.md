# ADR-002-Run-as-Trace-Primitive

## Status
Accepted

## Date
2026-09-13

## Context
Every intelligence action KIP performs must be traceable: who asked, for which project, which capability, which model, how long, what error. A single, thin trace concept prevents scattered ad-hoc logging and keeps trackability uniform across future skills.

## Decision
`Run` is the core trace primitive: one traceable unit of work. Runs are persisted in the `runs` table and are project-scoped. A Run is intentionally not a workflow graph, an event store, a conversation, or a raw-payload archive.

## Alternatives
- Distributed tracing only (OTel) — rejected: adds platform infrastructure before K0 needs it.
- No trace persistence — rejected: runs must outlive the process for diagnosis and audit.

## Consequences
- Runs are stored centrally, keyed by project.
- Observability consumes Run data.
- Storing raw input/output reflected in DB usage balances traceability with data minimization; future skills must not overload Run with business records.