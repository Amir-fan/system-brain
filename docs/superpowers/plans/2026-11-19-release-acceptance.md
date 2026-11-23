# Release Acceptance and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the client-requested package-by-package evidence, repository quality gates, and KIP-to-Naqaa integration documentation without claiming unrun live validation.

**Architecture:** Add lightweight repository-owned quality commands with no new package dependency, document the actual environment and endpoint contracts, and maintain one acceptance report that distinguishes local PASS from credential/device/staging NOT RUN.

**Tech Stack:** Node scripts, npm scripts, Markdown, existing TypeScript/Vite build.

**Spec:** `docs/superpowers/specs/2026-11-19-kip-client-scope-completion-design.md`

## Global Constraints

- Report only observed PASS, FAIL, or NOT RUN results.
- Do not treat local tests as proof of Supabase RLS, OpenRouter, device, Naqaa calendar, notification, or staging behavior.
- Do not add lint dependencies merely to satisfy a script name.
- Do not include real API keys, tokens, personal health data, or provider responses in documentation.
- Preserve all API integrations and document how keys will be supplied later.
- Do not commit, push, deploy, or change credentials.

## Review Focus

- Documentation must not imply KIP owns Naqaa calendar/notification persistence; Task 2 checks ownership language.
- Example menstrual data must be synthetic and obviously non-personal; Task 2 checks examples.
- The acceptance report must distinguish skipped tests from passing tests; Task 3 records counts separately.
- Secret scanning must inspect changed text without printing secret values; Task 1 uses names/patterns only.
- Live-test commands must fail closed or skip clearly when credentials are absent; Task 4 verifies no false PASS.

---

### Task 1: Add Honest Repository Quality Commands

**Files:**
- Create: `scripts/lint.mjs`
- Modify: `package.json`
- Test: `tests/repository-quality.test.ts`

**Interfaces:**
- Consumes: repository files, existing TypeScript compiler command, and Git diff output.
- Produces: `npm run lint` and `npm run verify:local` without installing a dependency.

- [ ] **Step 1: Write failing repository-quality tests**

Assert `package.json` exposes `lint` and `verify:local`; `scripts/lint.mjs` exits nonzero for a temporary fixture containing trailing whitespace, conflict markers, or a private-key header; it reports only file/line/category and never echoes the matched secret text.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --import tsx --test tests/repository-quality.test.ts`

Expected: FAIL because the script/commands do not exist.

- [ ] **Step 3: Implement the dependency-free lint script**

Scan tracked/source text extensions for conflict markers, trailing whitespace, committed `.env` variants, private-key headers, and common hard-coded provider-secret prefixes. Accept explicit paths for fixture tests and default to repository-owned source/config/docs files. Never print matched content.

- [ ] **Step 4: Add npm commands**

Set `lint` to the repository script and `verify:local` to run lint, root typecheck, root tests, and the frontend build in sequence using npm's platform-independent script chaining.

- [ ] **Step 5: Run quality tests and lint**

Run: `node --import tsx --test tests/repository-quality.test.ts`

Run: `npm run lint`

Expected: both exit 0 after real findings are fixed; do not weaken a check to hide a finding.

- [ ] **Step 6: Review checkpoint**

Inspect the script for sensitive-value echo, scanning outside the repository, and false claims that it replaces dependency auditing. Do not commit.

### Task 2: Complete README and Prediction API Documentation

**Files:**
- Modify: `README.md`
- Create: `docs/naqaa-cycle-prediction-api.md`
- Modify if needed: `.env.example`

**Interfaces:**
- Consumes: implemented routes, package commands, and actual environment-variable names.
- Produces: reproducible local setup and a synthetic KIP-to-Naqaa integration contract.

- [ ] **Step 1: Expand README from the verified repository state**

Document prerequisites, install command, `.env.local` setup, root/frontend commands, migration order, live-test prerequisites, and the explicit KIP-versus-Naqaa ownership boundary.

- [ ] **Step 2: Document every environment variable without values**

Separate server secrets from publishable frontend configuration. State that `SUPABASE_SECRET_KEY`, `OPENROUTER_API_KEY`, admin token, GitHub secret, and private key must remain server-side and outside Git.

- [ ] **Step 3: Document the prediction endpoint**

Include exact request/response schemas, validation limits, reliability definitions, calculation policy, stable error categories, fingerprint semantics, synthetic examples, and the statement that Naqaa owns calendar/notification reconciliation.

- [ ] **Step 4: Document correction and conflict behavior**

Explain that corrected canonical input produces a new fingerprint/forecast, and that `409 CONVERSATION_WRITE_CONFLICT` requires reload and intentional resubmission rather than blind automatic replay.

- [ ] **Step 5: Verify documentation against code**

Run: `rg -n "cycle-predictions|CONVERSATION_WRITE_CONFLICT|SUPABASE_SECRET_KEY|OPENROUTER_API_KEY|verify:local" README.md docs .env.example src package.json`

Check every documented name against its actual declaration; remove speculative commands or fields.

- [ ] **Step 6: Review checkpoint**

Check for real credentials, personal data, unsupported deployment claims, and ownership ambiguity. Do not commit.

### Task 3: Create the Client Acceptance Report

**Files:**
- Create: `docs/client-acceptance-status.md`

**Interfaces:**
- Consumes: actual command output from both implementation plans.
- Produces: one client package matrix with defect status, changed paths, evidence, execution environment, and remaining risk.

- [ ] **Step 1: Create the report structure before final verification**

Add rows for repair packages 1 through 8 and smart-prediction requirements 1 through 8. Each row must have: requirement, defect verified, change summary, file paths, test command, result, local/live scope, and remaining risk.

- [ ] **Step 2: Populate only evidence already observed**

Use `PASS` only for commands executed in the current workspace with exit 0. Use `NOT RUN` for credentials, device, Naqaa application, or staging gates that are unavailable.

- [ ] **Step 3: Record out-of-repository responsibilities**

List Naqaa device scanner UI, calendar persistence, notification scheduling, deployed fallback routing, and real-user switching as external acceptance—not KIP PASS.

- [ ] **Step 4: Verify report traceability**

For each production file changed, identify at least one client requirement or remove the unrelated change from this work. For each requirement marked PASS, identify the exact test or command output.

- [ ] **Step 5: Review checkpoint**

Read the report as a client: ensure it distinguishes “already worked,” “fixed,” “locally verified,” and “live verified.” Do not commit.

### Task 4: Run Final Local Gates and Record Exact Results

**Files:**
- Modify: `docs/client-acceptance-status.md`

**Interfaces:**
- Consumes: all completed production, test, and documentation work.
- Produces: final local verification evidence.

- [ ] **Step 1: Run lint**

Run: `npm run lint`

Record exit code and summary.

- [ ] **Step 2: Run root typecheck**

Run: `npm run typecheck`

Record exit code.

- [ ] **Step 3: Run the full root test suite**

Run: `npm test`

If localhost binding is blocked by the sandbox, rerun with the required localhost permission. Record total, passed, failed, and skipped counts separately.

- [ ] **Step 4: Run the frontend production build**

Run: `npm run build` from `frontend/`.

Record exit code and build summary.

- [ ] **Step 5: Run whitespace and change-scope checks**

Run: `git diff --check`

Run: `git status --short`

Record all untracked deliverables and ensure none is an accidental secret or generated QA artifact.

- [ ] **Step 6: Run the aggregate local command**

Run: `npm run verify:local`

Expected: exit 0 and the same results as the individual commands.

- [ ] **Step 7: Update the acceptance report with exact evidence**

Do not round counts, hide skips, or convert `NOT RUN` to PASS.

### Task 5: Prepare Credential and External Acceptance Gates

**Files:**
- Modify: `docs/client-acceptance-status.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing live tests and documented environment variables.
- Produces: exact commands and prerequisites for the user's later credential/staging session.

- [ ] **Step 1: Verify the no-credential behavior**

Run the live-test selection without secret values and confirm each unavailable integration is explicitly skipped or fails with a clear configuration error rather than a false PASS.

- [ ] **Step 2: Document the Supabase live gate**

Require `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY`; run existing live storage/API tests; verify two users and two projects cannot cross-read/write; record RLS/advisor status when access is available.

- [ ] **Step 3: Document the OpenRouter live gate**

Require `OPENROUTER_API_KEY` or configured Vault provider; run live model-gateway structured-output/message-role tests; ensure failures expose no key or submitted personal content.

- [ ] **Step 4: Document the admin model-assignment gate**

Require `KIP_PLATFORM_ADMIN_TOKEN` and the relevant provider configuration; run the existing admin/model-assignment tests.

- [ ] **Step 5: Document the external Naqaa journey**

Specify: real-device scan, one necessary question, answer, decision/refusal, correction, network retry, user/project switch, prediction recalculation, calendar update, notification reconciliation, and deployed KIP-failure behavior. Mark all as `NOT RUN` until the separate app/environment is available.

- [ ] **Step 6: Final report review**

Confirm no remaining item is described as a KIP code failure when it is actually an unavailable external acceptance environment.

### Task 6: Final Whole-Change Review

**Files:**
- None unless review finds a defect.

**Interfaces:**
- Consumes: all plans and verification evidence.
- Produces: merge-ready local worktree, still uncommitted and undeployed.

- [ ] **Step 1: Review correctness, readability, architecture, security, and performance**

Pay particular attention to prediction date math, API authorization, cross-process concurrency, correction invalidation, private-mode isolation, prompt roles, and logging.

- [ ] **Step 2: Verify no dead or duplicate path was introduced**

Run targeted symbol searches for the new prediction types/handler and current authorization helpers. Remove only newly introduced unused code; ask before deleting pre-existing elements.

- [ ] **Step 3: Re-run affected focused tests after any review fix**

Then rerun `npm run verify:local`.

- [ ] **Step 4: Stop before integration actions**

Report the final diff, exact verification evidence, and remaining external gates. Do not commit, push, open a PR, or deploy without explicit authorization.

## Final fiqh hardening fix round 1 evidence

- Added exact normalized style/format presentation aliases shared by control, Minimal, and Mind. Real private Conversation-to-Runtime regressions prove `output_style`, `responseStyle`, and `preferred_format` cannot authorize a personal result; clinical substring identifiers remain valid.
- Personal grounded session results now persist a bounded exact dependency proof. Control replay revalidates every dependency as current `CERTAIN/user_answer`, excludes presentation facts, enforces canonical compatibility, requires evidence and a server signature, and rejects legacy proofless results.
- Conversation persists and reports a grounded terminal only for supported personal `ANSWER`/`DECIDED` results with evidence and valid dependency proof. Gaps, unsupported results, missing evidence, and all malformed or unusable dependency cases remain ungrounded.

Verification: focused fiqh/admission suites 251 passed; replay/conversation compatibility 92 passed; Task 4 focused package 312 passed; localhost-enabled Task 7 matrix 501 passed; full suite 918 total, 893 passed, 0 failed, 25 credential-gated skips. Root typecheck, frontend production build, and `git diff --check` exited 0.

No API calls, key paths, dependencies, schemas, services, credentials, push, deploy, or destructive action changed in this round. Live-provider and external Naqaa/BES acceptance remain pending.
