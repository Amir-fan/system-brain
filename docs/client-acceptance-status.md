# KIP Next Client Acceptance Status

Date: 2026-11-24 (Europe/Istanbul)

Workspace: isolated `codex/kip-final-acceptance` worktree. The existing Vercel deployment was verified but not changed.

Result vocabulary: `PASS` means the listed local command completed successfully; `FAIL` means an observed failure; `NOT RUN` means the required credential, deployed service, device, or separate Naqaa environment was unavailable. A local PASS is never a live-environment PASS.

## Client repair packages

| # | Requirement | Defect verified | Change summary | Primary paths | Evidence command | Result | Scope | Remaining risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Privacy and tenant isolation | Yes: caller-controlled subjects and incomplete predicates could cross ownership boundaries. | Bind ordinary Memory, Skill, and Understanding operations to the authenticated actor; validate evaluation targets by project and actor; scope archive/read predicates; preserve trusted-service delegation only. | Authorization/storage handlers, `tests/subject-authorization.test.ts`, `tests/live/deployed-auth.live.test.ts` | Local suite plus deployed two-user/two-project test | PASS | Local and deployed live | Two real temporary Supabase users each saw only their own project; switching the project ID returned 403. |
| 2 | Separate fiqh authority from educational/observational data | Yes: alternate admission paths could promote untrusted facts into personal decisions. | Centralized material-fact admission; require exact user-answer provenance, evidence, dependency proof, and fail-closed personal decision contracts. | `src/core/readiness/material-fact-admission.ts`, `src/core/readiness/readiness.ts`, `src/domain/naqaa/fiqh-hayd-*.ts`, related admission/fiqh tests | `node --import tsx --test tests/material-fact-admission.test.ts tests/fiqh-hayd-decision.test.ts tests/fiqh-hayd-minimal-skill.test.ts tests/fiqh-hayd-mind-skill.test.ts` | PASS | Local deterministic | Live provider behavior and external Naqaa wording acceptance are NOT RUN. |
| 3 | No silent legacy or BES fallback | Yes: stale/legacy state and malformed grounded results had reuse paths. | Withhold invalid persisted results, invalidate stale rulings, enforce canonical skill IDs, and fail closed on gaps/refusals. | `src/core/conversation/conversation.service.ts`, `src/core/conversation/conversation.ts`, conversation and stale-turn tests | Local suites plus deployed unauthenticated/authenticated route checks | PASS | Local and deployed KIP boundary | Naqaa owns the separate proof that no application-side BES path is invoked. |
| 4 | Scanner contract, duration, time, Kuwait handling | Yes: media text, duration-unit, and clock-normalization boundaries needed hardening. | Exact scanner output allowlists; media-signature exclusion; distinct hour/day facts; bounded 12/24-hour and RFC 3339 normalization. | `src/domain/naqaa/scanner-skill.ts`, `src/core/understanding/numbers.ts`, scanner/understanding tests | `node --import tsx --test tests/scanner.test.ts tests/case-semantics.test.ts tests/minimum-questioning.test.ts tests/fiqh-hayd-decision.test.ts` | PASS | Local deterministic | Real-device scan and Naqaa UI are NOT RUN; optional note text beginning with literal `media:` may be conservatively omitted. |
| 5 | Corrections and stale-result invalidation | Yes: ambiguous/incompatible corrections and later terminal outcomes could leave reusable state. | Typed unique correction admission, explicit reconfirmation, material-change invalidation, and terminal transition clearing. | `src/core/conversation/conversation.service.ts`, `src/core/readiness/material-fact-admission.ts`, correction tests | `node --import tsx --test tests/case-semantics.test.ts tests/material-fact-confirmation.test.ts tests/answer-compatibility.test.ts` | PASS | Local deterministic | Live multi-process correction journey is NOT RUN. |
| 6 | Concurrency, retry, idempotency | Yes: cross-process stale writes required compare-and-swap behavior. | Per-conversation in-process queue plus storage CAS; stable `409 CONVERSATION_WRITE_CONFLICT`; client must reload and intentionally resubmit. | `src/core/conversation/conversation.service.ts`, `src/platform/provider/conversation.storage.ts`, `tests/live/supabase.live.test.ts` | Live concurrent saves against Supabase | PASS | Local and live database | Exactly one writer won and the stale writer received the typed conflict. Network retry UX remains a Naqaa acceptance item. |
| 7 | Relevant context and private mode | Yes: context leakage needed explicit proof. | Bounded relevant context only; private mode structurally excludes Memory/app context; current corrected facts outrank old context. | `src/core/conversation/conversation.service.ts`, `src/core/skill/skill-runtime.ts`, context/private tests | `node --import tsx --test tests/conversation-context-regression.test.ts tests/skill-turn-context.test.ts tests/appcontext-state-sync.test.ts` | PASS | Local deterministic | Staging user-switch behavior is NOT RUN. |
| 8 | Real acceptance and delivery evidence | Yes: repository lacked a current package matrix and reproducible final gates. | Added deterministic gates, live Supabase/deployed-auth coverage, deployment checks, and this report. | Quality scripts, live tests, README/API docs, this file | Local aggregate, live database suites, deployed route checks | PASS | KIP-owned scope | Device scanner, Naqaa calendar/notifications, and store UI remain external Naqaa acceptance. |

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
| `npm run lint` | Exit 0; `lint:passed:300` | PASS |
| `npm run typecheck` | Exit 0; `tsc -p tsconfig.json` | PASS |
| `npm test` | 1,023 total; 996 passed; 0 failed; 27 credential-gated skipped | PASS |
| `npm --prefix frontend run build` | Exit 0; 1,629 modules; JS 299.02 kB (90.06 kB gzip); CSS 20.38 kB (5.05 kB gzip) | PASS |
| `git diff --check` | Exit 0; no whitespace errors | PASS |
| `npm run verify:local` | Exit 0 after credential scrubbing; repeated lint, typecheck, root tests, and frontend build | PASS |
| Root `npm audit --audit-level=high` | Exit 0; 0 vulnerabilities | PASS |
| Frontend `npm audit` | Exit 0 after targeted Vite, React Router, and transitive PostCSS fixes; 0 vulnerabilities | PASS |
| Live Supabase/API suite | 21 total; 20 passed; 0 failed; 1 OpenRouter-only skip | PASS |
| Deployed two-user/two-project suite | 1 passed; 0 failed; fixtures removed | PASS |

No local `.env` variant, key file, build output, temporary user, or temporary project is part of the deliverable.

## Credential and external gates

Supabase and proxy credentials were available only through the ignored local environment file. No credential value was logged, committed, changed, or copied into application source. No API integration was removed or disabled.

### Frontend dependency audit — PASS

Targeted upgrades moved Vite to 8.3.8, `@vitejs/plugin-react` to 6.3.0, React Router DOM to 7.18.6, and the affected transitive PostCSS parser to 6.1.6. The production build and full audit pass with zero known vulnerabilities.

### Supabase live gate — PASS

Commands:

```powershell
node --env-file=.env.local --import tsx --test tests/live/supabase.live.test.ts tests/live/api.live.test.ts
$env:KIP_PUBLIC_API_URL='https://system-brain-frontend-swart.vercel.app'
node --env-file=.env.local --import tsx --test tests/live/deployed-auth.live.test.ts
```

The service-backed live matrix passed, including cross-project denial, content-free run records, and a real compare-and-swap race. The deployed test created two temporary confirmed Auth users and two projects, verified each user listed only her own project, verified project-ID switching returned 403, and removed all fixtures.

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

No commit, push, deployment, credential change, or database migration was performed. Live verification created only temporary acceptance fixtures and deleted them in test cleanup.
