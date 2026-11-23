# Client Hardening Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify and finish the KIP-owned portions of client repair packages 1 through 7 without rebuilding existing subsystems.

**Architecture:** Preserve the modular-monolith boundaries. Complete the current focused changes at API authorization, conversation state, model-gateway, and Naqaa skill seams; close a package without code changes when its acceptance behavior is already proven.

**Tech Stack:** TypeScript 5.5, Node test runner, Node HTTP server, Supabase adapter interfaces, OpenRouter adapter.

**Spec:** `docs/superpowers/specs/2026-11-19-kip-client-scope-completion-design.md`

## Global Constraints

- Verify a reported defect before changing production code.
- Do not rebuild Memory, Runtime, Understanding, or the fiqh skills.
- Do not add dependencies, tables, services, or new provider integrations.
- Preserve API calls and existing provider paths; no API key is currently available.
- Ordinary users derive subject identity from authentication; only trusted service membership may delegate.
- Never turn a provider/runtime failure into a valid fiqh answer or a missing-information result.
- Do not commit, push, deploy, change credentials, or delete legacy paths.

## Review Focus

- Owner membership must not grant another user's memory access; Task 1 tests owner and member paths.
- A stale conversation write from a second process must not overwrite the first; Task 3 tests compare-and-swap failure.
- An idempotent correction must not invalidate a valid result, while a material correction must; Task 2 tests both.
- A malformed or unavailable provider must remain a technical failure through retry/fallback paths; Task 4 tests both request attempts.
- A private conversation must retain session continuity without reading personal memory or app context; Task 5 tests both properties together.

---

### Task 1: Complete Subject Authorization and Archive Ownership

**Files:**
- Modify only if a test proves a gap: `src/platform/api/memory-handler.ts`
- Modify only if a test proves a gap: `src/platform/api/skill-handler.ts`
- Modify only if a test proves a gap: `src/core/memory/memory.ts`
- Modify only if a test proves a gap: `src/platform/provider/memory.storage.ts`
- Test: `tests/subject-authorization.test.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `authorizeProject(boundary, projectId, actor, operation)` and its verified membership role.
- Produces: end-user memory access bound to `{ scope: "user", subjectId: actor }`; trusted service delegation; archive predicates that include ownership.

- [ ] **Step 1: Run the existing focused authorization tests as the defect check**

Run: `node --import tsx --test tests/subject-authorization.test.ts tests/api.test.ts`

Expected: existing covered behavior passes. Record any failing acceptance path before editing.

- [ ] **Step 2: Add missing owner/member substitution cases before a production change**

Add tests asserting that both `member` and `owner` receive `403 MEMORY_SUBJECT_FORBIDDEN` or `403 SKILL_SUBJECT_FORBIDDEN` when supplying another subject, a conversation subject, or a case subject; assert `service` may delegate.

- [ ] **Step 3: Add a cross-project boundary assertion**

Test that a valid actor from project A cannot invoke memory or skill handlers for project B, even with its own subject identifier.

- [ ] **Step 4: Implement only the behavior required by a failing test**

Keep subject policy at the API boundary and ownership predicates at storage. Do not add a second authorization service.

- [ ] **Step 5: Verify package 1 locally**

Run: `node --import tsx --test tests/subject-authorization.test.ts tests/api.test.ts tests/memory.test.ts tests/skills.test.ts`

Expected: all tests pass; no cross-subject operation reaches the service mock.

- [ ] **Step 6: Review checkpoint**

Run: `git diff --check`

Inspect the Task 1 diff for BOLA/IDOR paths, error leakage, and unrelated refactors. Do not commit.

### Task 2: Complete Typed Corrections and Stale-Result Invalidation

**Files:**
- Modify only if a test proves a gap: `src/core/understanding/understanding.ts`
- Modify only if a test proves a gap: `src/core/understanding/understanding.service.ts`
- Modify only if a test proves a gap: `src/core/conversation/conversation.service.ts`
- Test: `tests/understanding.test.ts`
- Test: `tests/case-semantics.test.ts`
- Test: `tests/answer-compatibility.test.ts`
- Test: `tests/material-fact-confirmation.test.ts`

**Interfaces:**
- Consumes: `correctionValuesCompatible(current, replacement)` and uniquely resolved `UnderstandingCorrection.target`.
- Produces: compatible scalar replacement, superseded metadata, and grounded-result invalidation only when the value materially changes.

- [ ] **Step 1: Run correction-focused tests as the defect check**

Run: `node --import tsx --test tests/understanding.test.ts tests/case-semantics.test.ts tests/answer-compatibility.test.ts tests/material-fact-confirmation.test.ts`

- [ ] **Step 2: Add boundary tests before any further correction change**

Assert date-to-date and time-to-time corrections succeed; boolean-to-number, date-to-number, ambiguous two-date targets, and unresolved free text remain inert; reapplying the current value does not invalidate.

- [ ] **Step 3: Add the client correction scenario**

Seed `last_bleeding_start = "2026-11-01"`, correct it to `"2026-11-02"`, and assert the old fact is superseded, the new fact reaches the skill payload, and the prior grounded result is not reused.

- [ ] **Step 4: Implement only failing compatibility or invalidation behavior**

Keep generic scalar compatibility in Understanding and case-state invalidation in Conversation. Do not introduce Naqaa-specific keys into Core.

- [ ] **Step 5: Verify package 5 locally**

Run: `node --import tsx --test tests/understanding.test.ts tests/case-semantics.test.ts tests/answer-compatibility.test.ts tests/material-fact-confirmation.test.ts tests/stale-turn-regression.test.ts`

- [ ] **Step 6: Review checkpoint**

Run: `git diff --check`

Inspect for silent writes, arbitrary-target corrections, and stale grounded-result reuse. Do not commit.

### Task 3: Complete Conversation Concurrency and Conflict Semantics

**Files:**
- Modify only if a test proves a gap: `src/core/conversation/conversation.ts`
- Modify only if a test proves a gap: `src/core/conversation/conversation.service.ts`
- Modify only if a test proves a gap: `src/platform/provider/conversation.storage.ts`
- Modify only if a test proves a gap: `src/platform/api/conversation-handler.ts`
- Test: `tests/conversation-storage.test.ts`
- Test: `tests/conversation.test.ts`
- Test: `tests/run-reliability.test.ts`

**Interfaces:**
- Consumes: `ConversationStoragePort.save(session, expectedUpdatedAt)`.
- Produces: same-process per-conversation serialization and cross-process `409 CONVERSATION_WRITE_CONFLICT` compare-and-swap behavior.

- [ ] **Step 1: Run concurrency tests as the defect check**

Run: `node --import tsx --test tests/conversation-storage.test.ts tests/conversation.test.ts tests/run-reliability.test.ts`

- [ ] **Step 2: Add overlapping-turn regression assertions**

Use a delayed first skill call and a fast second call for the same conversation. Assert execution order is serialized and the saved context contains both turns without duplicate effectful skill execution.

- [ ] **Step 3: Add independent-conversation concurrency assertion**

Assert two different conversation IDs are not globally serialized.

- [ ] **Step 4: Add storage compare-and-swap assertion**

Assert the update query includes the original `updated_at`; a zero-row update throws `ConversationFailure("CONVERSATION_WRITE_CONFLICT")`; the API maps it to HTTP 409 with the stable code.

- [ ] **Step 5: Implement only failing queue, timestamp, storage, or API behavior**

Keep the in-process queue bounded to live conversation keys and always release it in `finally`.

- [ ] **Step 6: Verify package 6 locally**

Run: `node --import tsx --test tests/conversation-storage.test.ts tests/conversation.test.ts tests/run-reliability.test.ts tests/session-retry.test.ts`

- [ ] **Step 7: Review checkpoint**

Inspect for queue leaks, global serialization, automatic replay after unknown side effects, and timestamp collisions. Do not commit.

### Task 4: Prove Fiqh Failure Boundaries and No Silent Fallback

**Files:**
- Modify only if a test proves a gap: `src/core/skill/skill-runtime.ts`
- Modify only if a test proves a gap: `src/platform/model-gateway/openrouter.gateway.ts`
- Modify only if a test proves a gap: `src/domain/naqaa/fiqh-hayd-skill.ts`
- Modify only if a test proves a gap: `src/domain/naqaa/fiqh-hayd-minimal-skill.ts`
- Modify only if a test proves a gap: `src/domain/naqaa/fiqh-hayd-mind-skill.ts`
- Test: `tests/run-reliability.test.ts`
- Test: `tests/structured-output.test.ts`
- Test: `tests/fiqh-hayd-decision.test.ts`
- Test: `tests/material-fact-confirmation.test.ts`

**Interfaces:**
- Consumes: typed model-gateway failures and trusted `instructions` separated from untrusted message content.
- Produces: technical failure for unavailable providers; no fallback fiqh decision; personal decisions only after material facts and evidence are sufficient.

- [ ] **Step 1: Run existing failure and fiqh-boundary tests**

Run: `node --import tsx --test tests/run-reliability.test.ts tests/structured-output.test.ts tests/fiqh-hayd-decision.test.ts tests/material-fact-confirmation.test.ts`

- [ ] **Step 2: Add the three client decision-path tests**

Assert an educational question may return grounded education; a complete personal case may return a sourced decision; a personal case missing a material fact returns exactly one needed question or an insufficient result and never a decision.

- [ ] **Step 3: Add provider-unavailable and structured-output retry assertions**

Assert both the first request and JSON-mode retry preserve system/user message roles; timeout/provider errors stay `failed` and never become `needs_information`, `insufficient_evidence`, or a fiqh answer.

- [ ] **Step 4: Audit repository entry points for legacy fallback**

Run: `rg -n -i "\bBES\b|legacy|fallback|fiqh-hayd|defaultSkillId" src tests`

Document each actual fallback. Change only a path that can produce an unapproved ruling after a KIP failure.

- [ ] **Step 5: Implement only a verified failure-boundary gap**

Preserve benign retry of the same provider request and grounded session follow-up behavior; prohibit switching engines or skills after technical failure.

- [ ] **Step 6: Verify packages 2 and 3 locally**

Run: `node --import tsx --test tests/run-reliability.test.ts tests/structured-output.test.ts tests/fiqh-hayd-decision.test.ts tests/material-fact-confirmation.test.ts tests/fiqh-hayd-skill.test.ts tests/fiqh-hayd-minimal-skill.test.ts tests/fiqh-hayd-mind-skill.test.ts`

- [ ] **Step 7: Review checkpoint**

Inspect prompts for role confusion, provider error downgrades, invented confidence, and ungrounded decision paths. Do not commit.

### Task 5: Prove Relevant Context and Private-Mode Isolation

**Files:**
- Modify only if a test proves a gap: `src/core/conversation/conversation.ts`
- Modify only if a test proves a gap: `src/core/conversation/conversation.service.ts`
- Test: `tests/conversation-context-regression.test.ts`
- Test: `tests/minimum-questioning.test.ts`
- Test: `tests/skill-turn-context.test.ts`
- Test: `tests/stale-turn-regression.test.ts`
- Test: `tests/appcontext-state-sync.test.ts`

**Interfaces:**
- Consumes: `conversationPolicy(mode)` and bounded session context.
- Produces: current relevant facts, minimum questioning, and private continuity with zero personal Memory/app-context access.

- [ ] **Step 1: Run package 7 tests as the defect check**

Run: `node --import tsx --test tests/conversation-context-regression.test.ts tests/minimum-questioning.test.ts tests/skill-turn-context.test.ts tests/stale-turn-regression.test.ts tests/appcontext-state-sync.test.ts`

- [ ] **Step 2: Add a combined private-continuity assertion**

Assert turn 2 understands turn 1 from bounded session context while the memory adapter receives no personal read/write call and app context is absent from both case facts and model input.

- [ ] **Step 3: Add corrected-current-fact preference assertion**

Assert a corrected session fact overrides older memory and is not asked again.

- [ ] **Step 4: Implement only a verified policy/context gap**

Do not make private mode stateless; preserve bounded session continuity while structurally denying personal sources.

- [ ] **Step 5: Verify package 7 locally**

Run the same focused command from Step 1 and require zero failures.

- [ ] **Step 6: Review checkpoint**

Inspect for full-transcript growth, cross-case retrieval, personal-memory leakage, and repeated questions. Do not commit.

### Task 6: Close KIP Scanner and Time-Contract Gaps

**Files:**
- Modify only if a test proves a gap: `src/domain/naqaa/scanner-contracts.ts`
- Modify only if a test proves a gap: `src/domain/naqaa/scanner-skill.ts`
- Modify only if a test proves a gap: `src/core/understanding/understanding.service.ts`
- Test: `tests/scanner.test.ts`
- Test: `tests/understanding.test.ts`
- Test: `tests/case-semantics.test.ts`
- Test: `tests/answer-compatibility.test.ts`

**Interfaces:**
- Consumes: RFC 3339 `occurredAt`, typed `bleeding_duration_hours`, typed `bleeding_duration_days`, and normalized 24-hour time corrections.
- Produces: validated scanner evidence with explicit offsets; no hours/days substitution; canonical `HH:mm` understanding values.

- [ ] **Step 1: Add failing scanner timestamp tests**

Assert `2026-11-19T21:15:00+03:00` is accepted and preserved; a timestamp without timezone, an impossible date, and non-string `occurredAt` are rejected by `validateInput`.

- [ ] **Step 2: Add failing 12-hour/24-hour understanding tests**

Assert `الساعة 9 مساء` becomes `21:00`, `12 صباحاً` becomes `00:00`, `12 مساء` becomes `12:00`, and a correction from `09:00` to `10:00` supersedes the old value.

- [ ] **Step 3: Add duration-unit separation tests**

Assert a duration candidate in hours binds only `bleeding_duration_hours`; a duration in days binds only `bleeding_duration_days`; `duration_days` is not silently treated as either Naqaa field.

- [ ] **Step 4: Implement minimal validation/normalization for failing tests**

Keep timezone display and device input outside KIP. KIP accepts explicit-offset timestamps and canonicalizes understood clock text; it does not infer Kuwait time from a timezone-free timestamp.

- [ ] **Step 5: Verify package 4 KIP scope**

Run: `node --import tsx --test tests/scanner.test.ts tests/understanding.test.ts tests/case-semantics.test.ts tests/answer-compatibility.test.ts`

- [ ] **Step 6: Review checkpoint**

Inspect for timezone guessing, invalid Date rollover, duration aliasing, and raw-media persistence. Do not commit.

### Task 7: Hardening Plan Verification

**Files:**
- Modify: `docs/client-acceptance-status.md` in the release plan, not in this task.

**Interfaces:**
- Consumes: completed Tasks 1 through 6.
- Produces: locally verified evidence for client packages 1 through 7.

- [ ] **Step 1: Run all hardening-focused tests together**

Run: `node --import tsx --test tests/subject-authorization.test.ts tests/api.test.ts tests/understanding.test.ts tests/case-semantics.test.ts tests/answer-compatibility.test.ts tests/material-fact-confirmation.test.ts tests/conversation-storage.test.ts tests/conversation.test.ts tests/run-reliability.test.ts tests/structured-output.test.ts tests/fiqh-hayd-decision.test.ts tests/conversation-context-regression.test.ts tests/minimum-questioning.test.ts tests/skill-turn-context.test.ts tests/stale-turn-regression.test.ts tests/appcontext-state-sync.test.ts tests/scanner.test.ts`

Expected: zero failures.

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 3: Review the complete hardening diff**

Run: `git diff --check`

Confirm every production change maps to a verified client acceptance path and no API integration or secret-loading path was removed.
