# KIP Client Scope Completion Design

## Intent

Complete the work that belongs to KIP Next from the client's two supplied requirement sets: the eight limited repair packages and the approved smart cycle-prediction specification. The implementation must improve the existing system rather than replace Memory, Runtime, Understanding, or the fiqh skills, and it must preserve current production contracts unless a verified defect requires a compatible extension.

The result is for the Naqaa application and its end users. It must protect each user's private data, avoid unsupported personal fiqh decisions, preserve conversation continuity under corrections and retries, and provide a deterministic prediction contract that Naqaa can use for its calendar and notification features.

## Goals

- Close verified KIP-side gaps in client repair packages 1 through 7 with focused regression tests.
- Produce the KIP-side acceptance matrix and delivery evidence required by repair package 8.
- Add a deterministic cycle-prediction capability that works from the first recorded cycle and improves as confirmed cycle starts accumulate.
- Distinguish usual bleeding duration from total cycle length in both types and calculations.
- Recalculate from the caller's current canonical data, so a correction cannot leave a stale forecast.
- Return a prediction window and descriptive reliability label, never an invented percentage.
- Keep prediction statistically informative but incapable of changing a fiqh state or producing a fiqh ruling.
- Expose one stable API response that the Naqaa application can use to update its record, calendar, and notifications.
- Keep API keys optional for deterministic tests and preserve all existing provider/API integrations.

## Non Goals

- Rebuild KIP Runtime, Memory, Understanding, retrieval, or the fiqh engine.
- Build a machine-learning model or learning dataset.
- Add a new dependency, service, queue, or database table for prediction.
- Implement Naqaa's mobile UI, device scanner capture, calendar persistence, or notification scheduler inside this repository.
- Add new fiqh schools, advanced OCR, marketing features, or a second application.
- Delete legacy paths merely because they appear unused; removal requires usage evidence and separate approval.

## Anti Goals

- Do not duplicate Naqaa's source of truth for cycle history inside KIP.
- Do not treat a scan as a new cycle start unless the application has already confirmed it as canonical user data.
- Do not infer purification from the estimated end of usual bleeding.
- Do not expose service credentials, provider keys, system prompts, or personal data in responses or diagnostic logs.
- Do not convert an unavailable model/provider into an apparently valid answer from a different engine.
- Do not make a broad refactor while fixing a narrow verified defect.

## Constraints

- The current repository is TypeScript on Node, with a Node-native HTTP API and Supabase adapters.
- Existing project authorization remains the tenant boundary.
- Ordinary end-user requests must derive their subject from authenticated identity; only trusted service membership may delegate a different subject.
- Prediction is stateless in KIP. The caller supplies the current onboarding values and confirmed cycle-start history on every calculation.
- The algorithm is deterministic, explainable, timezone-independent for date-only cycle starts, and does not call an LLM.
- Dates use strict ISO calendar-date strings in `YYYY-MM-DD` form. Arithmetic uses UTC calendar days to avoid daylight-saving and local-offset drift.
- No secrets are required for unit, API-contract, typecheck, or frontend-build verification.
- Supabase/OpenRouter live tests remain an explicit final gate after credentials are supplied securely.
- No commit, push, deployment, credential change, or destructive operation occurs without explicit user authorization.

## Approaches Considered

### Chosen Approach  KIP Owned Stateless Prediction

Add a pure Naqaa domain module and a thin authenticated API handler. Naqaa continues to own onboarding, cycle history, calendar entries, and notification scheduling. KIP accepts the current canonical data and returns a forecast contract that includes the central estimate, date window, descriptive reliability, calculation evidence, and explicit non-fiqh semantics.

This approach follows the current clean module boundaries, needs no migration, automatically reflects corrections, and does not create a second source of truth.

### Rejected Approach  Persist Cycles and Forecasts in KIP

Add KIP tables for cycle events, forecasts, calendar state, and notification state. This could centralize integration, but it duplicates Naqaa application state, introduces migrations and retention obligations, and conflicts with the client's instruction not to add tables or services without a separately demonstrated need.

### Rejected Approach  Defer Prediction Until the Naqaa Repository Is Available

Finish only the original repair packages. This avoids an integration boundary, but it leaves a direct later client request incomplete. The KIP-owned pure calculation and API contract can be completed and verified independently now.

## Existing Architecture and Change Boundaries

KIP separates core orchestration from domain skills and platform adapters. The completion work preserves those seams:

- `src/domain/naqaa/` owns Naqaa-specific domain contracts and pure calculation.
- `src/platform/api/` owns authenticated HTTP parsing, validation, and response mapping.
- `src/platform/api/http-server.ts` registers the new endpoint through the existing router.
- `src/platform/bootstrap/composition.ts` composes the prediction service without provider credentials.
- `tests/` verifies domain behavior, API authorization, existing repair packages, and acceptance scenarios.
- `supabase/migrations/` is unchanged unless a later verified KIP persistence requirement receives separate approval.

The current uncommitted hardening changes remain in scope. They are reviewed and completed rather than discarded or rewritten.

## Cycle Prediction Domain

### Input Contract

The prediction request contains only current canonical data:

- `lastCycleStart`: required ISO date of the latest confirmed cycle start.
- `typicalBleedingDays`: required positive integer describing usual bleeding duration.
- `typicalCycleDays`: optional positive integer describing the usual start-to-start cycle length.
- `regularity`: `regular`, `irregular`, or `unknown`.
- `confirmedCycleStarts`: optional chronological or unsorted list of confirmed ISO start dates. Duplicate dates are rejected rather than silently counted twice.
- The public request has no caller-controlled clock. The API supplies the current UTC calendar date through an injected clock so tests remain deterministic and a caller cannot make future data appear current.

`typicalBleedingDays` is never substituted for `typicalCycleDays`. When the latter is unknown, the explicit initial default is 28 days and the reliability is `needs_more_data`.

Scanner observations, color, texture, and model confidence are not accepted as cycle starts. The caller must first confirm and store a canonical cycle-start fact through the appropriate Naqaa flow.

### Output Contract

The response contains:

- `predictedNextStart`: central estimated ISO date.
- `windowStart` and `windowEnd`: inclusive forecast range.
- `estimatedBleedingEnd`: usual-duration estimate from the latest start.
- `reliability`: `initial`, `history_based`, or `needs_more_data`.
- `basis`: `{ latestCycleStart, baselineCycleDays, usedDefaultCycleDays, actualIntervalsDays, weightedExpectedCycleDays, windowOffsetsDays: { min, max } }`.
- `integration`: `{ contractVersion: "naqaa-cycle-prediction-v1", inputFingerprint, forecast: { predictedNextStart, windowStart, windowEnd, reliability }, estimatedBleedingEnd }`. Naqaa may copy this one stable object into its record/calendar/notification reconciliation flow.
- `fiqhImpact: "none"` and `purificationDetermination: false`.

No numeric confidence percentage is returned. `inputFingerprint` is `sha256:` followed by lower-case hexadecimal SHA-256 over UTF-8 `JSON.stringify` output of a fixed-order canonical object containing `contractVersion`, `lastCycleStart`, `typicalBleedingDays`, `typicalCycleDays` or `null`, `regularity`, and the sorted confirmed starts. Equivalent input order therefore produces the same fingerprint.

### Calculation Policy

1. Validate and normalize date-only inputs without using local time.
2. Sort confirmed starts and ensure `lastCycleStart` equals the latest confirmed start when history is supplied. A mismatch is a validation error because silently choosing one could preserve stale data. A confirmed start after the server-supplied current UTC date is also invalid.
3. Calculate actual cycle intervals as UTC calendar-day differences between consecutive starts.
4. Establish a baseline from `typicalCycleDays`; otherwise use the disclosed 28-day initial default.
5. With no actual interval, use the baseline as the central expected length.
6. With actual intervals, compute a recency-weighted mean. The baseline has weight 1 and actual intervals have increasing weights 2 through `n + 1`, so confirmed recent data progressively outweighs onboarding data without erasing it after one observation.
7. Round the central expected length to the nearest whole day.
8. Build the range from observed interval variation. With no interval, use a symmetric half-width of 2 days when a typical length is known and 4 days when the 28-day default is used. With one observed interval, use the central estimate plus or minus 1 day. With two or more observed intervals, use the observed minimum and maximum intervals as the direct lower and upper offsets rather than forcing symmetry. In all history cases, union that range with the central estimate plus or minus 1 day. An explicitly `irregular` onboarding value further unions it with the central estimate plus or minus 4 days. After these unions, floor the lower offset at 1 day so the forecast window remains strictly after the latest confirmed start.
9. Add the expected length and range offsets to the latest confirmed start.
10. Estimate usual bleeding end from `typicalBleedingDays` only, counting the start date as day 1. For a January 1 start and a duration of 7 days, the estimate is January 7. Mark it as non-fiqh, non-purification information.

The forecast always describes the immediate next expected start after the latest confirmed start. It never invents missed cycles by rolling a stale estimate forward to the current date. Naqaa decides how to present or reconcile an overdue estimate from its own current state.

The calculation exposes its basis so the policy is testable and reviewable. Constants live in the prediction module and are named rather than embedded in the API handler.

### Reliability Policy

- `needs_more_data`: total cycle length was unknown and no actual interval exists.
- `initial`: a user-provided usual cycle length exists but no actual interval exists.
- `history_based`: at least one actual start-to-start interval exists.

This vocabulary follows the client's approved descriptive approach. It deliberately does not claim measured accuracy.

## API Design

Add `POST /v1/projects/{projectId}/naqaa/cycle-predictions`.

The handler:

1. Authenticates through the existing project boundary.
2. Accepts only JSON and validates every field before domain execution.
3. Does not accept an end-user-controlled `subjectId`; the operation is stateless and therefore has no reason to identify another user.
4. Applies conservative request-size and list-length limits.
5. Returns `400` for invalid or inconsistent dates and values, `403` or `404` through the existing authorization semantics, and `200` with the prediction contract on success.
6. Returns stable error codes suitable for Naqaa integration without exposing internal stack traces.
7. Does not log the submitted menstrual history.

The existing HTTP JSON-body ceiling remains 1,000,000 characters. The prediction-specific boundary accepts at most 120 confirmed cycle starts, dates from `1900-01-01` through the injected current UTC date, and integer `typicalBleedingDays` and `typicalCycleDays` values from 1 through 366. These are technical abuse-prevention limits, not medical claims.

The response's `integration` object is the KIP-to-Naqaa handoff. Naqaa remains responsible for comparing the returned fingerprint/version with its current calendar and notification records and updating those records transactionally.

## Repair Package Completion

### Package 1  User and Project Data Protection

Complete the current subject-authorization patch. Ordinary member/owner memory operations are bound to the authenticated actor. Conversation/case scopes require a trusted service path until an ownership resolver exists. Archive operations include scope and subject predicates. Add API regression tests for cross-user and cross-project identifier substitution and preserve defense-in-depth RLS verification for the live Supabase gate.

### Package 2  Fiqh Decision Versus Educational Answer

Verify three explicit paths: educational information, personal decision, and materially incomplete personal case. Personal decisions require complete material facts and supported evidence. Missing material facts return only the next required question or an insufficient result. Prediction output is not evidence for changing fiqh state.

### Package 3  No Silent Legacy Fallback

Trace all KIP entry points present in this repository. Provider/runtime failures remain technical failures and must not become a fiqh decision, `needs_information`, or output from a different skill. Because BES and the Naqaa mobile entry points are not present here, KIP produces an acceptance contract and tests its own failure semantics; final Naqaa-side verification remains an external acceptance item.

### Package 4  Scanner Contract Result and Time Handling

Verify the existing scanner and fiqh contracts agree on actually used fields, especially hours versus days and `cycle_interval_days`. Add contract tests for 12-hour and 24-hour inputs and Kuwait-offset timestamps where the KIP boundary receives timestamps. Date-only prediction arithmetic remains independent of timezone. Physical-device UI execution remains a Naqaa acceptance item.

### Package 5  Corrections and Stale Result Invalidation

Complete the current typed-correction work. A correction replaces only a uniquely resolved compatible fact, invalidates a grounded result when the fact value materially changes, and recomputes downstream results. An ambiguous or incompatible correction cannot erase a valid fact.

### Package 6  Concurrency Retry and Idempotency

Complete the current per-conversation serialization and optimistic compare-and-swap patch. Same-process turns serialize; cross-process stale writes return `409 CONVERSATION_WRITE_CONFLICT`. Confirm retry behavior does not duplicate effectful execution and document that clients must reload and intentionally resubmit after a conflict rather than automatically replaying an unknown side effect.

### Package 7  Relevant Conversation Context and Private Mode

Verify bounded relevant context, current-fact preference after corrections, minimum questioning, and structural private-mode denial of personal Memory read/write and app context. Ensure untrusted retrieved/user content remains in the model's user message while trusted capability instructions remain in the system message.

### Package 8  Real Journey Acceptance and Delivery Evidence

Create a version-controlled English acceptance report with one row per client package: verified defect, files changed, command/test result, local versus live status, and remaining external risk. Local deterministic gates must pass without secrets. Supabase/OpenRouter/staging/device rows remain clearly marked `NOT RUN` until the user supplies credentials or the Naqaa environment.

## Security and Privacy

- Authentication is required before prediction input is parsed into a successful operation.
- Authorization remains project-scoped and does not trust user-editable metadata.
- The prediction API stores nothing and logs no menstrual dates or health context.
- Validation rejects oversized histories, invalid ISO dates, duplicates, non-positive durations, non-finite numbers, and inconsistent latest dates.
- Trusted system instructions and untrusted user/retrieved text use separate model roles.
- Provider errors are normalized without leaking request bodies, keys, stack traces, or provider responses containing sensitive input.
- Existing secret-loading behavior is preserved. No key is embedded, deleted, or moved to a public frontend variable.
- Live RLS tests cover two users and two projects once Supabase credentials are available.

## Error Handling

- Domain validation uses typed prediction failures with stable codes.
- API handlers translate expected failures into existing response envelopes.
- Unexpected failures return a generic message plus server-side diagnostics that contain no health data.
- Conversation conflicts return 409 and remain distinguishable from validation, authorization, and provider failures.
- Prediction never falls back to an LLM or a default fiqh answer.

## Verification Strategy

Each behavior change follows red-green-refactor:

1. Add a focused failing test.
2. Run that test and verify the expected failure.
3. Implement the smallest change.
4. Run the focused test.
5. Run the relevant neighboring test file.
6. Review the diff for authorization, privacy, stale-state, and compatibility regressions.

Final local gates:

- Full root test suite.
- Root TypeScript typecheck.
- Frontend production build.
- Diff whitespace check.
- Secret-pattern scan of changed files.
- Dependency audit and lint after a repository-appropriate lint gate is introduced or the absence is explicitly resolved.

Credential-dependent gates:

- Supabase live storage/RLS tests with two users and two projects.
- OpenRouter live structured-output and message-role tests.
- Model-assignment/admin route test.
- Naqaa staging journey: scan, one necessary question, answer, decision or refusal, correction, network retry, user switch, prediction recalculation, calendar update, and notification reconciliation.

## Documentation and Delivery

- Expand the README with setup, environment variables, commands, migrations, endpoint usage, and explicit KIP-versus-Naqaa ownership.
- Document the prediction endpoint with example requests and responses that contain no real personal data.
- Keep the client acceptance report factual: `PASS`, `FAIL`, or `NOT RUN`, never infer a live result from a local test.
- Do not commit, push, publish, or deploy during implementation unless the user separately authorizes it.

## Builder Decisions

The builder may choose exact helper names, error-code suffixes, and test-fixture organization when those choices do not change the public API or policies above. The builder must not change the algorithm, add persistence, widen scope, or weaken a client acceptance condition without returning for approval.
