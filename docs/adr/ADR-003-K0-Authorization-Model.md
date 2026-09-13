# ADR-003-K0-Authorization-Model

## Status
Accepted

## Date
2026-09-13

## Context
K0 needs to answer two questions: may this Actor access this Project, and may this Actor invoke this capability. The architecture constitution forbids a large identity platform or enterprise RBAC in Core.

## Decision
Use a minimal hybrid authorization model: project membership (a constrained role of `owner | member | service`) plus a code-registered capability check. No roles table, no permissions table, no policy DSL, no dynamic permission engine. Knowing a `project_id` does not authorize access; authorization always comes from a trusted Actor context.

## Alternatives
- Full RBAC — rejected: overengineered for a thin K0 spine.
- Policy-as-code engine — rejected: complexity not yet earned; not cross-domain needed yet.
- No authorization in K0 — rejected: project isolation is a core requirement.

## Consequences
- Authorization is enforced in Core runtime, not only at the DB.
- Capability authorization lives in code, so adding a capability is a code change today.
- If policy flexibility is truly needed later, it can be layered without rewriting Core authorization.