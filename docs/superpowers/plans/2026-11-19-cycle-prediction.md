# Naqaa Cycle Prediction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the client-approved deterministic cycle prediction capability to KIP without adding persistence, machine learning, or fiqh side effects.

**Architecture:** A pure Naqaa domain function validates canonical onboarding/history data and returns a versioned forecast. A thin authenticated project API handler exposes the function; Naqaa remains the owner of cycle history, calendar records, and notification scheduling.

**Tech Stack:** TypeScript 5.5, Node standard library `crypto`, Node test runner, existing Node HTTP API.

**Spec:** `docs/superpowers/specs/2026-11-19-kip-client-scope-completion-design.md`

## Global Constraints

- No new dependencies, database tables, queues, or provider calls.
- Prediction must work from one confirmed start and improve from actual start-to-start intervals.
- `typicalBleedingDays` must never substitute for `typicalCycleDays`.
- Use strict ISO dates and UTC calendar-day arithmetic.
- Return descriptive reliability only; never return an accuracy percentage.
- Prediction must not change a fiqh state, establish purification, or invoke a fiqh skill.
- Scanner observations are not accepted as cycle starts.
- No menstrual history may be logged or persisted by KIP.
- Do not commit, push, deploy, or modify credentials.

## Review Focus

- Leap days and month/year boundaries must preserve calendar-day arithmetic; Task 1 tests them.
- Equivalent unsorted history must produce the same fingerprint; Task 2 tests canonicalization.
- Duplicate starts, stale latest-start mismatch, and future starts must fail explicitly; Task 1 tests them.
- Highly variable intervals must widen the range without producing a numeric confidence; Task 2 tests them.
- A caller must not smuggle scanner evidence, subject delegation, or fiqh state into the accepted contract; Task 3 tests boundary rejection.

---

### Task 1: Define and Validate the Pure Prediction Contract

**Files:**
- Create: `src/domain/naqaa/cycle-prediction.ts`
- Create: `tests/cycle-prediction.test.ts`

**Interfaces:**
- Consumes: caller data only; no service or storage dependency.
- Produces:
  - `CyclePredictionInput`
  - `CycleRegularity = "regular" | "irregular" | "unknown"`
  - `CyclePredictionReliability = "initial" | "history_based" | "needs_more_data"`
  - `CyclePredictionResult`
  - `CyclePredictionFailure` with stable validation codes
  - `predictCycle(input: CyclePredictionInput, currentDate: string): CyclePredictionResult`

- [ ] **Step 1: Write failing validation and initial-prediction tests**

Add tests with these assertions:

- `lastCycleStart: "2026-11-01"`, `typicalBleedingDays: 7`, `typicalCycleDays: 30` predicts center `2026-12-01`, window `2026-11-29` through `2026-12-03`, bleeding-end estimate `2026-11-07`, reliability `initial`.
- Omitting `typicalCycleDays` uses baseline 28, reliability `needs_more_data`, and a plus/minus 4-day window.
- `typicalBleedingDays: 7` never makes the expected cycle length 7.
- Missing/invalid ISO dates, impossible dates, future starts, duplicates, latest-start mismatch, non-integers, values outside 1 through 366, and histories longer than 120 throw the expected `CyclePredictionFailure` code.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --import tsx --test tests/cycle-prediction.test.ts`

Expected: FAIL because `cycle-prediction.ts` does not exist.

- [ ] **Step 3: Implement the contract and strict UTC date helpers**

Create `predictCycle(input, currentDate)` and private date parsing/addition helpers. Reject JavaScript Date rollover by comparing parsed UTC components back to the source string. Count the start as bleeding day 1.

- [ ] **Step 4: Run Task 1 tests**

Run: `node --import tsx --test tests/cycle-prediction.test.ts`

Expected: all initial and validation tests pass.

- [ ] **Step 5: Add leap/month boundary tests**

Assert a 30-day prediction from `2027-01-31` crosses February correctly and a duration spanning `2028-02-29` remains correct.

- [ ] **Step 6: Review checkpoint**

Run: `git diff --check`

Inspect for local-time constructors, hidden medical thresholds, and magic values. Do not commit.

### Task 2: Add Progressive History Weighting, Ranges, and Fingerprint

**Files:**
- Modify: `src/domain/naqaa/cycle-prediction.ts`
- Modify: `tests/cycle-prediction.test.ts`

**Interfaces:**
- Consumes: Task 1 validated and sorted starts.
- Produces: `basis`, descriptive reliability, observed-variation window, and canonical `sha256:` input fingerprint.

- [ ] **Step 1: Write failing history-progression tests**

Assert:

- Starts `2026-08-01`, `2026-08-31` with baseline 28 produce one actual 30-day interval, reliability `history_based`, and a central weighted length of 29 days using weights baseline=1 and actual=2.
- Additional intervals receive weights 2 through `n + 1`; a recent interval moves the estimate more than the onboarding baseline.
- With two or more intervals, `windowOffsetsDays.min/max` include the observed minimum/maximum directly.
- `regularity: "irregular"` unions the range with central plus/minus 4 days.
- Reordering equivalent confirmed starts does not change `inputFingerprint`.
- Changing a corrected start changes the fingerprint and recalculated forecast.
- The result contains no percentage-like confidence field.

- [ ] **Step 2: Run the focused test and verify new cases fail**

Run: `node --import tsx --test tests/cycle-prediction.test.ts`

- [ ] **Step 3: Implement recency weighting and range calculation**

Use baseline weight 1 and interval weights 2 through `n + 1`; round the weighted mean to a whole day. Follow the direct/minimum range policy from the design.

- [ ] **Step 4: Implement canonical fingerprinting**

Use Node `createHash("sha256")` over UTF-8 JSON of the fixed-order canonical object. Prefix lower-case hex output with `sha256:`.

- [ ] **Step 5: Run prediction tests**

Run: `node --import tsx --test tests/cycle-prediction.test.ts`

Expected: all tests pass deterministically.

- [ ] **Step 6: Mutation check the weighting tests**

Temporarily change one interval weight or swap a window boundary, run the focused test to confirm failure, then restore the intended code with `apply_patch`.

- [ ] **Step 7: Review checkpoint**

Inspect for order-dependent fingerprints, division/rounding ambiguity, and accidental numeric confidence. Do not commit.

### Task 3: Add the Authenticated Prediction API Handler

**Files:**
- Create: `src/platform/api/cycle-prediction-handler.ts`
- Create: `tests/cycle-prediction-api.test.ts`

**Interfaces:**
- Consumes: `authorizeProject`, `Actor`, `predictCycle`, and an injected `currentDate(): string` dependency.
- Produces:
  - `CyclePredictionApiDeps { boundary: ProjectBoundaryReaders; currentDate?: () => string }`
  - `handleCyclePrediction(deps, projectId, actor, body): Promise<ApiResult>`

- [ ] **Step 1: Write failing handler tests**

Assert:

- Authorized project membership receives `200` and the exact versioned response.
- Missing membership receives existing `403/404` semantics.
- Invalid body fields map to `400` with stable prediction error codes.
- `subjectId`, scanner evidence, fiqh state fields, caller-controlled `asOf`, and more than the allowed history are rejected rather than ignored.
- The handler does not call a provider, storage adapter, Memory, conversation, or skill.

- [ ] **Step 2: Run the handler test and verify it fails**

Run: `node --import tsx --test tests/cycle-prediction-api.test.ts`

Expected: FAIL because the handler does not exist.

- [ ] **Step 3: Implement the thin handler**

Authorize first, validate an exact allowlist of public fields, obtain current UTC date from the injected clock, call `predictCycle`, and translate expected failures into the standard API envelope. Do not include request data in errors.

- [ ] **Step 4: Run handler and domain tests**

Run: `node --import tsx --test tests/cycle-prediction.test.ts tests/cycle-prediction-api.test.ts`

Expected: zero failures.

- [ ] **Step 5: Review checkpoint**

Inspect for authorization after processing, unknown-field acceptance, personal-data logging, and error-detail leakage. Do not commit.

### Task 4: Register the Prediction HTTP Route

**Files:**
- Modify: `src/platform/api/http-server.ts`
- Modify: `src/platform/bootstrap/composition.ts`
- Modify: `tests/cycle-prediction-api.test.ts`

**Interfaces:**
- Consumes: `CyclePredictionApiDeps` and `handleCyclePrediction` from Task 3.
- Produces: `POST /v1/projects/{projectId}/naqaa/cycle-predictions` through the existing authenticated project router.

- [ ] **Step 1: Write a failing real-server route test**

Start the existing Node server on `127.0.0.1`, submit an authenticated prediction request, and assert HTTP 200 plus the forecast contract. Assert GET returns 404/405 according to existing router behavior and an unauthorized token cannot reach the handler.

- [ ] **Step 2: Run the API test and verify the route case fails**

Run: `node --import tsx --test tests/cycle-prediction-api.test.ts`

- [ ] **Step 3: Add the optional dependency and exact route**

Extend `HttpApiDeps` with `cyclePrediction?: CyclePredictionApiDeps`, route the exact POST path before generic fallthrough, and compose `{ boundary }` without provider credentials.

- [ ] **Step 4: Run API and authorization tests**

Run: `node --import tsx --test tests/cycle-prediction-api.test.ts tests/api.test.ts tests/subject-authorization.test.ts`

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Review checkpoint**

Inspect for route shadowing, body parsing before authentication, and accidental dependency on Supabase/OpenRouter environment variables. Do not commit.

### Task 5: Prove Prediction and Fiqh Separation

**Files:**
- Modify: `tests/cycle-prediction.test.ts`
- Modify: `tests/cycle-prediction-api.test.ts`
- Modify only if a test proves a gap: `src/domain/naqaa/cycle-prediction.ts`

**Interfaces:**
- Consumes: Tasks 1 through 4 prediction result.
- Produces: explicit `fiqhImpact: "none"` and `purificationDetermination: false` contract with no decision side effect.

- [ ] **Step 1: Add separation tests**

Assert every result contains `fiqhImpact: "none"` and `purificationDetermination: false`; the serialized output contains no `hayd`, `tuhr`, `istihada`, decision label, ruling, prayer, or fasting field; changing a prediction never mutates any supplied input object.

- [ ] **Step 2: Add estimated-bleeding disclaimer assertions**

Assert `estimatedBleedingEnd` is computed from `typicalBleedingDays`, is independent of the next-start calculation, and is not labeled purification.

- [ ] **Step 3: Run domain and API tests**

Run: `node --import tsx --test tests/cycle-prediction.test.ts tests/cycle-prediction-api.test.ts`

- [ ] **Step 4: Review checkpoint**

Confirm the prediction module imports no fiqh skill, Memory, model gateway, or persistence module. Do not commit.

### Task 6: Prediction Plan Verification

**Files:**
- None unless verification reveals a defect.

**Interfaces:**
- Consumes: completed Tasks 1 through 5.
- Produces: locally verified KIP prediction capability ready for Naqaa integration.

- [ ] **Step 1: Run complete prediction verification**

Run: `node --import tsx --test tests/cycle-prediction.test.ts tests/cycle-prediction-api.test.ts`

Expected: zero failures.

- [ ] **Step 2: Run neighboring Naqaa tests**

Run: `node --import tsx --test tests/scanner.test.ts tests/case-semantics.test.ts tests/minimum-questioning.test.ts tests/fiqh-hayd-decision.test.ts`

Expected: zero regressions.

- [ ] **Step 3: Run static checks**

Run: `npm run typecheck`

Run: `git diff --check`

Expected: both exit 0.
