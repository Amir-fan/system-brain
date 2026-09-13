# KIP Engineering Constitution

## Naming
One concept = one canonical name.
Do not create synonyms for the same concept.

If a term is accepted, reuse it everywhere unless the concept is genuinely different.

## Naming registry discipline
Before introducing a new core term, add it to the naming registry only if the concept is confirmed and stable.
Do not fill the registry with future guesses.

## File naming
TypeScript filenames use:
- kebab-case
- responsibility suffixes

Examples:
- model-gateway.service.ts
- model-gateway.types.ts
- model-gateway.test.ts

Database names use snake_case.
TypeScript variables and functions use camelCase.
Types, interfaces, and classes use PascalCase.

## Module organization
Organize code by domain and responsibility.
Do not use project-wide buckets such as services, controllers, repositories, or types as the primary structure.
Each domain owns its own files.

## Folder depth
Keep folder depth as flat as possible.
Do not create deep helper chains or nested utility forests without a real reason.

## Generic files
Avoid generic file names such as:
- utils.ts
- helpers.ts
- common.ts
- misc.ts
- functions.ts

If a file can be named clearly, name it clearly.

## Traceability tags
Use the KIP header only for architecture-critical or important files:

```ts
/**
 * @kip
 * @module <canonical-module>
 * @layer <core|intelligence|skill|platform>
 * @owner <canonical-owner>
 * @feature <feature-id>
 * @purpose <one clear sentence>
 */
```

Do not add @created.
Do not stamp every helper file.
Git is the history system.

## Feature IDs
Use feature IDs only for real work.
Start with compact identifiers such as K0-001, K0-002, K0-003 when a feature truly exists.
Do not invent a large catalog in advance.

## Git standard
Use Conventional Commits only:
- feat:
- fix:
- refactor:
- test:
- docs:
- chore:
- perf:

Avoid vague commit messages such as update, changes, final, or final2.

## Comments
Comments should explain why, not what.
Do not comment obvious code.
Add comments only when the decision or constraint is not visible from the code itself.

## Configuration
Configuration must be centralized and explicit.
Do not hard-code provider URLs, model names, or secrets into business logic or source code.

## Clean code gates
A feature is not complete unless it has:
- one clear owner
- no duplicate responsibility
- no dead code
- no commented-out backup code
- no unused exports
- no orphan files
- no circular dependencies
- no unexplained magic values
- no secrets in code
- no architectural boundary violations
- passing typecheck
- passing lint
- passing relevant tests
- naming aligned to the registry

Clean code is a release requirement, not a polish step.
