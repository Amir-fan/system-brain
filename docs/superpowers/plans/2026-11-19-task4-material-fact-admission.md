# Task 4 Material Fact Admission — Implementation Plan

## Objective

Replace lexical question classification as a fact-authorization gate with deterministic admission against the active interaction contract, while preserving the existing Conversation wire Interface.

## Step 1 — Characterize the unsafe seam

- Add integration regressions in `tests/material-fact-confirmation.test.ts` for common unlisted Arabic/English questions and Gulf Arabic confirmation.
- Add tests that deliberately misclassify questions as `STATEMENT`; they must still remain unable to create a confirmed material fact or label.
- Add direct tests for exact whole-value raw answers and structured free-text answers.

Verification: targeted tests must fail before production changes.

## Step 2 — Add the in-process admission Module

- Add a small core Module near Conversation/Readiness with a pure Interface for:
  - structured answer admission;
  - exact pending raw-answer admission;
  - explicit-correction admission;
  - confirmed-material-fact validation.
- Reuse canonical interaction types, digit normalization, uncertainty option, and compatibility validation.
- Keep parsers whole-input and fail closed.

Verification: Module tests cover every interaction type and failure mode.

## Step 3 — Route Conversation through admission

- Replace `dialogueAct`-gated plain binding with admission of exact raw answers.
- Keep Understanding for routing and user-facing interpretation only.
- Require explicit bounded correction syntax before applying an Understanding correction.
- Ensure skill-returned `caseFacts` cannot become confirmed user answers.
- Preserve correction invalidation, precedence, queueing, private-mode, and CAS behavior.

Verification: Conversation, correction, stale-result, private-context, and compatibility suites.

## Step 4 — Close the label gate

- Require `CERTAIN + user_answer + usable value` for each Minimal `materialFactKey`.
- Add direct Minimal tests showing `user_statement`, evidence, Memory, missing provenance, and uncertain values cannot authorize a personal label.

Verification: Minimal and material-fact suites.

## Step 5 — Independent review and aggregate verification

- Run Task 4 focused suites, related Tasks 2/3/5 regressions, full tests, typecheck, and diff check.
- Independently review for alternate write paths and compatibility regressions.
- Reopen Task 4 only if no Critical/Important finding remains.

## Constraints

No commit, push, deployment, dependency, table, service, credential, or legacy-path deletion. Preserve unrelated working-tree changes.
