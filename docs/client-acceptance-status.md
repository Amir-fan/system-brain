# KIP Next Client Acceptance Status

Date: 2026-11-21 (Europe/Istanbul)

Workspace: local Windows checkout, uncommitted and undeployed

Result vocabulary: `PASS` means the listed local command completed successfully; `FAIL` means an observed failure; `NOT RUN` means the required credential, deployed service, device, or separate Naqaa environment was unavailable. A local PASS is never a live-environment PASS.

## Client repair packages

| # | Requirement | Defect verified | Change summary | Primary paths | Evidence command | Result | Scope | Remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Privacy and tenant isolation | Yes: caller-controlled subjects and incomplete predicates could cross ownership boundaries. | Bind ordinary Memory, Skill, and Understanding operations to the authenticated actor; validate evaluation targets by project and actor; scope archive/read predicates; preserve trusted-service delegation only. | `src/platform/api/memory-handler.ts`, `src/platform/api/skill-handler.ts`, `src/platform/api/understanding-handler.ts`, `src/platform/api/conversation-handler.ts`, `src/platform/provider/memory.storage.ts`, `src/platform/provider/evaluation.storage.ts`, `tests/subject-authorization.test.ts` | `node --import tsx --test tests/subject-authorization.test.ts tests/api.test.ts` and aggregate Task 7 matrix | PASS | Local deterministic | Live Supabase RLS with two real users/projects is NOT RUN. |
| 2 | Separate fiqh authority from educational/observational data | Yes: alternate admission paths could promote untrusted facts into personal decisions. | Centralized material-fact admission; require exact user-answer provenance, evidence, dependency proof, and fail-closed personal decision contracts. | `src/core/readiness/material-fact-admission.ts`, `src/core/readiness/readiness.ts`, `src/domain/naqaa/fiqh-hayd-*.ts`, related admission/fiqh tests | `node --import tsx --test tests/material-fact-admission.test.ts tests/fiqh-hayd-decision.test.ts tests/fiqh-hayd-minimal-skill.test.ts tests/fiqh-hayd-mind-skill.test.ts` | PASS | Local deterministic | Live provider behavior and external Naqaa wording acceptance are NOT RUN. |
| 3 | No silent legacy or BES fallback | Yes: stale/legacy state and malformed grounded results had reuse paths. | Withhold invalid persisted results, invalidate stale rulings, enforce canonical skill IDs, and fail closed on gaps/refusals. | `src/core/conversation/conversation.service.ts`, `src/core/conversation/conversation.ts`, conversation and stale-turn tests | `node --import tsx --test tests/conversation.test.ts tests/conversation-context-regression.test.ts tests/stale-turn-regression.test.ts` | PASS | Local deterministic | Deployed fallback routing and BES integration are NOT RUN. |
| 4 | Scanner contract, duration, time, Kuwait handling | Yes: media text, duration-unit, and clock-normalization boundaries needed hardening. | Exact scanner output allowlists; media-signature exclusion; distinct hour/day facts; bounded 12/24-hour and RFC 3339 normalization. | `src/domain/naqaa/scanner-skill.ts`, `src/core/understanding/numbers.ts`, scanner/understanding tests | `node --import tsx --test tests/scanner.test.ts tests/case-semantics.test.ts tests/minimum-questioning.test.ts tests/fiqh-hayd-decision.test.ts` | PASS | Local deterministic | Real-device scan and Naqaa UI are NOT RUN; optional note text beginning with literal `media:` may be conservatively omitted. |
| 5 | Corrections and stale-result invalidation | Yes: ambiguous/incompatible corrections and later terminal outcomes could leave reusable state. | Typed unique correction admission, explicit reconfirmation, material-change invalidation, and terminal transition clearing. | `src/core/conversation/conversation.service.ts`, `src/core/readiness/material-fact-admission.ts`, correction tests | `node --import tsx --test tests/case-semantics.test.ts tests/material-fact-confirmation.test.ts tests/answer-compatibility.test.ts` | PASS | Local deterministic | Live multi-process correction journey is NOT RUN. |
| 6 | Concurrency, retry, idempotency | Yes: cross-process stale writes required compare-and-swap behavior. | Per-conversation in-process queue plus storage CAS; stable `409 CONVERSATION_WRITE_CONFLICT`; client must reload and intentionally resubmit. | `src/core/conversation/conversation.service.ts`, `src/platform/provider/conversation.storage.ts`, API/storage tests | `node --import tsx --test tests/conversation-storage.test.ts tests/run-reliability.test.ts tests/conversation.test.ts` | PASS | Local deterministic | Real database race/network retry remains NOT RUN without credentials. |
| 7 | Relevant context and private mode | Yes: context leakage needed explicit proof. | Bounded relevant context only; private mode structurally excludes Memory/app context; current corrected facts outrank old context. | `src/core/conversation/conversation.service.ts`, `src/core/skill/skill-runtime.ts`, context/private tests | `node --import tsx --test tests/conversation-context-regression.test.ts tests/skill-turn-context.test.ts tests/appcontext-state-sync.test.ts` | PASS | Local deterministic | Staging user-switch behavior is NOT RUN. |
| 8 | Real acceptance and delivery evidence | Yes: repository lacked a current package matrix and reproducible final gates. | Added quality commands, integration docs, and this PASS/FAIL/NOT RUN report. | `scripts/lint.mjs`, `scripts/verify-local.mjs`, `tests/repository-quality.test.ts`, `README.md`, API doc, this file | `npm run verify:local` | PASS | Local credential-free aggregate | Credentials, device, staging, Naqaa calendar/notifications remain NOT RUN. |

## Smart prediction requirements

| # | Requirement | Defect verified | Change summary | Primary paths | Evidence command | Result | Scope | Remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Start prediction from the first confirmed cycle | Missing capability, not a regression. | Stateless forecast works with one latest confirmed start and disclosed fallback. | `src/domain/naqaa/cycle-prediction.ts`, `tests/cycle-prediction.test.ts` | `node --import tsx --test tests/cycle-prediction.test.ts` | PASS | Local deterministic | Naqaa onboarding UI integration is NOT RUN. |
| 2 | Keep bleeding duration separate from cycle length | Missing capability. | Distinct validated fields; bleeding days affect only `estimatedBleedingEnd`. | `src/domain/naqaa/cycle-prediction.ts`, `tests/cycle-prediction.test.ts` | `node --import tsx --test tests/cycle-prediction.test.ts` | PASS | Local deterministic | Medical/product wording requires client acceptance. |
| 3 | Progressive history-based improvement | Missing capability. | Recency weights baseline 1 and intervals 2..n+1; bounded observed ranges. | `src/domain/naqaa/cycle-prediction.ts`, `tests/cycle-prediction.test.ts` | `node --import tsx --test tests/cycle-prediction.test.ts` | PASS | Local deterministic | No clinical accuracy claim is made. |
| 4 | Corrections recalculate rather than preserve stale forecasts | Missing capability. | Stateless canonical input and fingerprint; corrected history produces a new result. | Domain/tests and API doc | `node --import tsx --test tests/cycle-prediction.test.ts` | PASS | Local deterministic | Naqaa calendar reconciliation is NOT RUN. |
| 5 | Return ranges and descriptive reliability | Missing capability. | Inclusive future-only window; `initial`, `needs_more_data`, or `history_based`; no percentage. | Domain/tests | `node --import tsx --test tests/cycle-prediction.test.ts` | PASS | Local deterministic | Product presentation is owned by Naqaa. |
| 6 | Calendar and notification handoff | Missing KIP contract. | Versioned `integration` object with fingerprint and forecast; no KIP persistence. | Domain, handler, `docs/naqaa-cycle-prediction-api.md` | `node --import tsx --test tests/cycle-prediction-api.test.ts` | PASS | Local KIP contract only | Naqaa calendar write and notification scheduling are NOT RUN. |
| 7 | Handle missing/invalid information safely | Missing capability. | Exact field allowlist; strict dates; bounds, duplicates, future and mismatch errors; safe transport limit. | Domain/handler/server/tests | `node --import tsx --test tests/cycle-prediction.test.ts tests/cycle-prediction-api.test.ts tests/api.test.ts tests/subject-authorization.test.ts` | PASS | Local deterministic | Live client error rendering is NOT RUN. |
| 8 | Keep prediction separate from fiqh | Missing capability. | Explicit `fiqhImpact: "none"`, `purificationDetermination: false`; no skill/model/Memory/persistence dependency. | Domain/handler/tests | `node --import tsx --test tests/cycle-prediction.test.ts tests/cycle-prediction-api.test.ts` | PASS | Local deterministic | Client must not relabel estimates as rulings. |

## Final local gates

This section is updated only from commands executed after all code and documentation changes.

| Gate | Exact result | Status |
| --- | --- | --- |
| `npm run lint` | Exit 0; `lint:passed:285` | PASS |
| `npm run typecheck` | Exit 0; `tsc -p tsconfig.json` | PASS |
| `npm test` | 1,013 total; 988 passed; 0 failed; 25 credential-gated skipped | PASS |
| `npm --prefix frontend run build` | Exit 0; 1,641 modules; JS 287.42 kB (86.06 kB gzip); CSS 21.85 kB (5.06 kB gzip) | PASS |
| `git diff --check` | Exit 0; no whitespace errors | PASS |
| `npm run verify:local` | Exit 0 after credential scrubbing; repeated lint, typecheck, root tests, and frontend build | PASS |
| Root `npm audit --audit-level=high` | Exit 0; 0 vulnerabilities | PASS |
| Frontend `npm audit --audit-level=high` | Exit 1; 6 advisories: 2 high, 4 moderate | FAIL |
| Frontend `npm audit --omit=dev --json` | Exit 1; 2 moderate React Router advisories; 0 high/critical | FAIL |

`git status --short` reported 73 modified/untracked entries. They are the accumulated uncommitted hardening, prediction, tests, plans, quality tooling, documentation, and the previously delivered Arabic report. No local `.env` variant, key file, build output, or temporary QA fixture appears in the deliverable list. The final clean aggregate completed every local gate.

## Credential and external gates

No API keys were supplied in this workspace. No API integration was removed or disabled.

The credential-gated selection was also executed with the relevant variables explicitly unset: 25 total, 0 passed, 0 failed, 25 skipped. Exit 0 in that selection means “all unavailable gates skipped,” not live acceptance.

### Frontend dependency audit — FAIL

The frontend lockfile currently resolves vulnerable development/build dependencies (`vite`/`esbuild`, `source-map-js`, and `postcss-selector-parser`) and a vulnerable runtime routing dependency (`react-router-dom`/`react-router`). The full-tree high-severity findings are confined to development/build tooling (`vite` and `source-map-js`). The production-only audit reports two moderate React Router advisories and no high/critical issue. Current runtime reachability appears low because this frontend uses `BrowserRouter`, has no SSR hydration, and uses hard-coded navigation destinations; this reduces risk but does not clear the advisories. npm proposes breaking major upgrades for Vite and React Router to clear all findings. No automatic or forced dependency update was applied because those upgrades require a separately reviewed migration and regression pass. This is a release blocker until remediated or explicitly risk-accepted; the successful production build does not override it.

### Supabase live gate — NOT RUN

Prerequisites: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` supplied through a secure local/deployment mechanism; migrations `0001`–`0017` applied to the intended isolated project.

Commands after configuration:

```powershell
node --import tsx --env-file=.env.local --test tests/live/supabase.live.test.ts tests/live/api.live.test.ts
```

Acceptance must include two users and two projects, denied cross-read/write, private Storage isolation, actual RLS policies, and Supabase security/advisor review. Local mock or service-key tests do not replace this gate.

### OpenRouter live gate — NOT RUN

Prerequisite: `OPENROUTER_API_KEY` for these test files. The API integration case also requires `SUPABASE_URL` and `SUPABASE_SECRET_KEY`. A Vault-only runtime credential does not make this test command eligible and must not be reported as a provider-test PASS. Run:

```powershell
node --import tsx --env-file=.env.local --test tests/live/model-gateway.live.test.ts tests/live/api.live.test.ts
```

Verify structured output/message roles and ensure failures expose neither the key nor submitted health content.

### Admin model-assignment gate — NOT RUN

Prerequisites: `KIP_PLATFORM_ADMIN_TOKEN`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY`. A configured provider improves model-catalog validation coverage but is not required for the admin authorization/CRUD contract. Run:

```powershell
node --import tsx --env-file=.env.local --test tests/model-assignment-api.test.ts
```

### External Naqaa/staging journey — NOT RUN

The separate application/environment must exercise: real-device scan; exactly one necessary question; answer; grounded decision or refusal; correction and recalculation; network retry; user/project switch; prediction fingerprint change; calendar replacement; notification reconciliation; and the deployed behavior when KIP is unavailable. These are Naqaa/device/staging responsibilities, not KIP local PASS claims.

## Change traceability

- Authorization/storage files map to repair package 1.
- Readiness, fiqh skill, gateway, evidence, and admission files map to packages 2–3.
- Scanner and number-normalization files map to package 4.
- Conversation state/correction files map to package 5.
- Conversation storage/queue/API files map to package 6.
- Context and private-mode paths map to package 7.
- Prediction domain/handler/server/composition paths map to smart prediction requirements 1–8.
- README, environment templates, quality script/tests, plans, reports, and the Arabic client report map to package 8 delivery evidence.

No commit, push, deployment, credential change, database migration execution, or destructive action was performed.
