# ADR-001-Project-as-Tenancy-Boundary

## Status
Accepted

## Date
2026-09-13

## Context
KIP is a multi-tenant intelligence platform. Many future resources (runs, capabilities, skills, knowledge) must be isolated per customer. The architecture constitution requires one canonical isolation term and forbids synonyms for the same concept.

## Decision
`Project` is the single canonical tenancy and isolation boundary. No separate `Tenant`, `Workspace`, or `Organization` term is introduced as a synonym. Every future project-scoped resource must carry and respect a `project_id`.

## Alternatives
- `Tenant` as a distinct term — rejected: adds a second term for the same boundary.
- No explicit boundary — rejected: multi-tenant isolation is a core platform requirement.

## Consequences
- All project-scoped tables reference `projects.id`.
- Authorization checks are always project-scoped.
- Introducing `Tenant` later would require a deliberate new concept, not a rename.