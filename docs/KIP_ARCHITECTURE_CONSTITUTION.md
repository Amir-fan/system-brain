# KIP Architecture Constitution

## Vision
KIP is a multi-tenant intelligence platform. It is not a single-purpose chatbot and it is not tied to one domain.

## Multi-tenant principle
Every project is isolated by design. Tenant, project, identity, permissions, runtime, and observability are platform concerns.

## Core boundaries
KIP Core must stay small.
It may own only these shared responsibilities:
- Project / Tenant
- Identity
- Permissions
- Runtime
- Run
- Model Gateway
- Basic Events / Jobs
- Observability

Core must not absorb domain logic, skill logic, or intelligence features that are not broadly shared.

## Shared Intelligence Services
Shared Intelligence Services are not Core. They may provide:
- Conversation
- Context
- Memory
- Understanding
- Knowledge
- Retrieval
- Evaluation

These services support Core and Skills, but they do not redefine Core.

## Skills boundaries
Skills are specialized capabilities layered on top of Core and approved Shared Intelligence Services.
A Skill must not duplicate its own:
- auth
- memory infrastructure
- model gateway
- knowledge runtime
- conversation runtime
- project management

## Modular Monolith
KIP starts as a modular monolith.
Do not introduce microservices, distributed architecture, custom event buses, event sourcing, or other heavy abstractions before the platform proves they are necessary.

## Ownership rule
One responsibility.
One owner.
One implementation.
One active path.

If a concept cannot be placed clearly, do not create it.

## No duplicate infrastructure
Do not build parallel systems for the same concern.
No duplicate brains.
No V1 / V2 / V3 / legacy / new / final structures for the same idea.

## Dependency direction
Platform may call Core.
Shared Intelligence Services use Core.
Skills use Core plus approved Shared Intelligence Services.

Core must not depend on Skills or on domain-specific logic.
Core must remain domain-agnostic.

## Complexity must be earned
Simple, correct, and explainable comes first.
Complexity is allowed only when it is justified by real cross-domain need.

## Naqaa is proof, not definition
Naqaa is the first proof of architecture, not the definition of KIP.
KIP must stay general enough to support other apps, websites, SaaS products, projects, companies, and knowledge bases.

## Phase order
Only these phases are defined now:
- K0 — Platform Foundation
- K1 — Intelligence Foundation
- K2 — Naqaa Fiqh Skill
- K3 — Project Intelligence

No additional phases are defined in this constitution.
