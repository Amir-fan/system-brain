import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CyclePredictionFailure,
  predictCycle,
  type CyclePredictionFailureCode,
  type CyclePredictionInput,
} from '../src/domain/naqaa/cycle-prediction.ts';

const CURRENT_DATE = '2026-11-21';

const initialInput = (): CyclePredictionInput => ({
  lastCycleStart: '2026-11-01',
  typicalBleedingDays: 7,
  typicalCycleDays: 30,
  regularity: 'regular',
});

function assertPredictionFailure(
  input: unknown,
  currentDate: unknown,
  expectedCode: CyclePredictionFailureCode,
): void {
  assert.throws(
    () => predictCycle(input as CyclePredictionInput, currentDate as string),
    (error: unknown) => error instanceof CyclePredictionFailure && error.code === expectedCode,
  );
}

test('predicts the initial next start, inclusive window, and bleeding end in UTC days', () => {
  const result = predictCycle(initialInput(), CURRENT_DATE);

  assert.equal(result.predictedNextStart, '2026-12-01');
  assert.equal(result.windowStart, '2026-11-29');
  assert.equal(result.windowEnd, '2026-12-03');
  assert.equal(result.estimatedBleedingEnd, '2026-11-07');
  assert.equal(result.reliability, 'initial');
  assert.deepEqual(result.basis, {
    latestCycleStart: '2026-11-01',
    baselineCycleDays: 30,
    usedDefaultCycleDays: false,
    actualIntervalsDays: [],
    weightedExpectedCycleDays: 30,
    windowOffsetsDays: { min: 28, max: 32 },
  });
  assert.deepEqual(result.integration.forecast, {
    predictedNextStart: '2026-12-01',
    windowStart: '2026-11-29',
    windowEnd: '2026-12-03',
    reliability: 'initial',
  });
  assert.equal(result.integration.contractVersion, 'naqaa-cycle-prediction-v1');
  assert.match(result.integration.inputFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.integration.estimatedBleedingEnd, '2026-11-07');
  assert.equal(result.fiqhImpact, 'none');
  assert.equal(result.purificationDetermination, false);
});

test('uses the disclosed 28-day default and wider window when cycle length is unknown', () => {
  const input = initialInput();
  delete input.typicalCycleDays;

  const result = predictCycle(input, CURRENT_DATE);

  assert.equal(result.predictedNextStart, '2026-11-29');
  assert.equal(result.windowStart, '2026-11-25');
  assert.equal(result.windowEnd, '2026-12-03');
  assert.equal(result.reliability, 'needs_more_data');
  assert.equal(result.basis.baselineCycleDays, 28);
  assert.equal(result.basis.usedDefaultCycleDays, true);
  assert.equal(result.basis.weightedExpectedCycleDays, 28);
  assert.deepEqual(result.basis.windowOffsetsDays, { min: 24, max: 32 });
});

test('never substitutes typical bleeding duration for total cycle length', () => {
  const result = predictCycle({
    lastCycleStart: '2026-11-01',
    typicalBleedingDays: 7,
    regularity: 'unknown',
  }, CURRENT_DATE);

  assert.equal(result.predictedNextStart, '2026-11-29');
  assert.notEqual(result.basis.weightedExpectedCycleDays, 7);
});

test('rejects missing input fields and unsupported regularity values', () => {
  assertPredictionFailure(null, CURRENT_DATE, 'PREDICTION_INPUT_INVALID');
  assertPredictionFailure({}, CURRENT_DATE, 'PREDICTION_INPUT_INVALID');
  assertPredictionFailure({ ...initialInput(), regularity: 'sometimes' }, CURRENT_DATE, 'PREDICTION_INPUT_INVALID');
});

test('rejects malformed and impossible ISO calendar dates without rollover', () => {
  for (const lastCycleStart of ['2026-1-01', '2026-11-1', '2026/11/01', '2026-02-29', '2026-04-31']) {
    assertPredictionFailure({ ...initialInput(), lastCycleStart }, CURRENT_DATE, 'PREDICTION_DATE_INVALID');
  }
  assertPredictionFailure(initialInput(), '2026-02-29', 'PREDICTION_DATE_INVALID');
  assertPredictionFailure({
    ...initialInput(),
    confirmedCycleStarts: ['2026-10-01', '2026-02-29', '2026-11-01'],
  }, CURRENT_DATE, 'PREDICTION_DATE_INVALID');
});

test('rejects dates outside the technical lower bound and after the injected current date', () => {
  assertPredictionFailure({ ...initialInput(), lastCycleStart: '1899-12-31' }, CURRENT_DATE, 'PREDICTION_DATE_OUT_OF_RANGE');
  assertPredictionFailure(initialInput(), '1899-12-31', 'PREDICTION_DATE_OUT_OF_RANGE');
  assertPredictionFailure({ ...initialInput(), lastCycleStart: '2026-11-22' }, CURRENT_DATE, 'PREDICTION_DATE_IN_FUTURE');
  assertPredictionFailure({
    ...initialInput(),
    confirmedCycleStarts: ['2026-11-01', '2026-11-22'],
  }, CURRENT_DATE, 'PREDICTION_DATE_IN_FUTURE');
});

test('rejects non-integer, non-finite, and out-of-range duration values', () => {
  for (const typicalBleedingDays of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertPredictionFailure({ ...initialInput(), typicalBleedingDays }, CURRENT_DATE, 'PREDICTION_NUMBER_INVALID');
  }
  for (const typicalCycleDays of [2.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
    assertPredictionFailure({ ...initialInput(), typicalCycleDays }, CURRENT_DATE, 'PREDICTION_NUMBER_INVALID');
  }
  for (const typicalBleedingDays of [0, -1, 367]) {
    assertPredictionFailure({ ...initialInput(), typicalBleedingDays }, CURRENT_DATE, 'PREDICTION_NUMBER_OUT_OF_RANGE');
  }
  for (const typicalCycleDays of [0, -1, 367]) {
    assertPredictionFailure({ ...initialInput(), typicalCycleDays }, CURRENT_DATE, 'PREDICTION_NUMBER_OUT_OF_RANGE');
  }
});

test('rejects duplicate, oversized, and stale confirmed histories with stable codes', () => {
  assertPredictionFailure({
    ...initialInput(),
    confirmedCycleStarts: ['2026-10-01', '2026-10-01', '2026-11-01'],
  }, CURRENT_DATE, 'PREDICTION_HISTORY_DUPLICATE');

  const oversizedHistory = Array.from({ length: 121 }, (_, index) => {
    const day = String((index % 28) + 1).padStart(2, '0');
    return `2026-01-${day}`;
  });
  assertPredictionFailure({ ...initialInput(), confirmedCycleStarts: oversizedHistory }, CURRENT_DATE, 'PREDICTION_HISTORY_TOO_LONG');

  assertPredictionFailure({
    ...initialInput(),
    confirmedCycleStarts: ['2026-09-01', '2026-10-01'],
  }, CURRENT_DATE, 'PREDICTION_LATEST_START_MISMATCH');
});

test('uses UTC calendar arithmetic across a short February and month boundary', () => {
  const result = predictCycle({
    lastCycleStart: '2027-01-31',
    typicalBleedingDays: 7,
    typicalCycleDays: 30,
    regularity: 'regular',
  }, '2027-02-01');

  assert.equal(result.predictedNextStart, '2027-03-02');
  assert.equal(result.windowStart, '2027-02-28');
  assert.equal(result.windowEnd, '2027-03-04');
  assert.equal(result.estimatedBleedingEnd, '2027-02-06');
});

test('counts the start as bleeding day one across leap day', () => {
  const result = predictCycle({
    lastCycleStart: '2028-02-27',
    typicalBleedingDays: 4,
    typicalCycleDays: 30,
    regularity: 'regular',
  }, '2028-02-27');

  assert.equal(result.predictedNextStart, '2028-03-28');
  assert.equal(result.estimatedBleedingEnd, '2028-03-01');
});

test('weights one actual interval above the onboarding baseline', () => {
  const result = predictCycle({
    lastCycleStart: '2026-08-31',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-31'],
  }, CURRENT_DATE);

  assert.equal(result.reliability, 'history_based');
  assert.deepEqual(result.basis.actualIntervalsDays, [30]);
  assert.equal(result.basis.weightedExpectedCycleDays, 29);
  assert.deepEqual(result.basis.windowOffsetsDays, { min: 28, max: 30 });
  assert.equal(result.predictedNextStart, '2026-09-29');
  assert.equal(result.windowStart, '2026-09-28');
  assert.equal(result.windowEnd, '2026-09-30');
});

test('preserves the exact baseline-one and first-interval-two weighting ratio', () => {
  const result = predictCycle({
    lastCycleStart: '2026-10-11',
    typicalBleedingDays: 7,
    typicalCycleDays: 20,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-09-01', '2026-10-11'],
  }, CURRENT_DATE);

  assert.deepEqual(result.basis.actualIntervalsDays, [40]);
  assert.equal(result.basis.weightedExpectedCycleDays, 33);
  assert.equal(result.predictedNextStart, '2026-11-13');
});

test('gives later actual intervals higher recency weights', () => {
  const recentLongInterval = predictCycle({
    lastCycleStart: '2026-10-03',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-29', '2026-10-03'],
  }, CURRENT_DATE);
  const recentShortInterval = predictCycle({
    lastCycleStart: '2026-10-03',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-09-05', '2026-10-03'],
  }, CURRENT_DATE);

  assert.deepEqual(recentLongInterval.basis.actualIntervalsDays, [28, 35]);
  assert.equal(recentLongInterval.basis.weightedExpectedCycleDays, 32);
  assert.deepEqual(recentShortInterval.basis.actualIntervalsDays, [35, 28]);
  assert.equal(recentShortInterval.basis.weightedExpectedCycleDays, 30);
});

test('uses observed minimum and maximum offsets directly with two or more intervals', () => {
  const result = predictCycle({
    lastCycleStart: '2026-10-03',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-29', '2026-10-03'],
  }, CURRENT_DATE);

  assert.deepEqual(result.basis.windowOffsetsDays, { min: 28, max: 35 });
  assert.equal(result.windowStart, '2026-10-31');
  assert.equal(result.windowEnd, '2026-11-07');
});

test('unions irregular history with the central estimate plus or minus four days', () => {
  const result = predictCycle({
    lastCycleStart: '2026-10-03',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'irregular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-29', '2026-10-03'],
  }, CURRENT_DATE);

  assert.deepEqual(result.basis.windowOffsetsDays, { min: 28, max: 36 });
  assert.equal(result.windowStart, '2026-10-31');
  assert.equal(result.windowEnd, '2026-11-08');
});

test('canonicalizes history order for calculation and the fixed-order SHA-256 fingerprint', () => {
  const sortedInput: CyclePredictionInput = {
    lastCycleStart: '2026-10-03',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-29', '2026-10-03'],
  };
  const unsortedInput: CyclePredictionInput = {
    ...sortedInput,
    confirmedCycleStarts: ['2026-10-03', '2026-08-01', '2026-08-29'],
  };
  const originalUnsortedInput = structuredClone(unsortedInput);

  const sortedResult = predictCycle(sortedInput, CURRENT_DATE);
  const unsortedResult = predictCycle(unsortedInput, CURRENT_DATE);

  assert.equal(
    sortedResult.integration.inputFingerprint,
    'sha256:7dbbdf1e2202984ea68f43950c9666c43db18ba7f12e22107e720b648433db90',
  );
  assert.equal(unsortedResult.integration.inputFingerprint, sortedResult.integration.inputFingerprint);
  assert.deepEqual(unsortedResult.basis, sortedResult.basis);
  assert.deepEqual(unsortedInput, originalUnsortedInput);
});

test('a corrected confirmed start changes both fingerprint and recalculated forecast', () => {
  const original = predictCycle({
    lastCycleStart: '2026-10-03',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-29', '2026-10-03'],
  }, CURRENT_DATE);
  const corrected = predictCycle({
    lastCycleStart: '2026-10-03',
    typicalBleedingDays: 7,
    typicalCycleDays: 28,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-30', '2026-10-03'],
  }, CURRENT_DATE);

  assert.notEqual(corrected.integration.inputFingerprint, original.integration.inputFingerprint);
  assert.deepEqual(corrected.basis.actualIntervalsDays, [29, 34]);
  assert.equal(corrected.basis.weightedExpectedCycleDays, 31);
  assert.equal(corrected.predictedNextStart, '2026-11-03');
  assert.notEqual(corrected.predictedNextStart, original.predictedNextStart);
});

test('returns descriptive reliability without a numeric or percentage-like confidence field', () => {
  const result = predictCycle({
    lastCycleStart: '2026-08-31',
    typicalBleedingDays: 7,
    regularity: 'unknown',
    confirmedCycleStarts: ['2026-08-01', '2026-08-31'],
  }, CURRENT_DATE);

  assert.equal(result.reliability, 'history_based');
  const keys = JSON.stringify(result, (_key, value: unknown) => value);
  assert.equal(/confidence|accuracy|percentage|percent/i.test(keys), false);
  assert.equal(/hayd|tuhr|istihada|ruling|prayer|fasting/i.test(keys), false);
  assert.equal(result.fiqhImpact, 'none');
  assert.equal(result.purificationDetermination, false);
});

test('keeps every prediction variant non-fiqh and leaves canonical health input unchanged', () => {
  const variants: CyclePredictionInput[] = [
    initialInput(),
    {
      lastCycleStart: '2026-11-01',
      typicalBleedingDays: 7,
      regularity: 'unknown',
    },
    {
      lastCycleStart: '2026-10-03',
      typicalBleedingDays: 7,
      typicalCycleDays: 28,
      regularity: 'irregular',
      confirmedCycleStarts: ['2026-08-01', '2026-08-29', '2026-10-03'],
    },
  ];

  for (const input of variants) {
    const before = structuredClone(input);
    if (input.confirmedCycleStarts) Object.freeze(input.confirmedCycleStarts);
    Object.freeze(input);

    const result = predictCycle(input, CURRENT_DATE);
    const serialized = JSON.stringify(result);

    assert.equal(result.fiqhImpact, 'none');
    assert.equal(result.purificationDetermination, false);
    assert.equal(/hayd|tuhr|istihada|decisionLabel|ruling|prayer|fasting/i.test(serialized), false);
    assert.deepEqual(input, before);
  }
});

test('keeps the bleeding-duration estimate independent from the next-start forecast', () => {
  const thirtyDayCycle = predictCycle(initialInput(), CURRENT_DATE);
  const fortyDayCycle = predictCycle({ ...initialInput(), typicalCycleDays: 40 }, CURRENT_DATE);
  const fiveDayBleeding = predictCycle({ ...initialInput(), typicalBleedingDays: 5 }, CURRENT_DATE);

  assert.equal(thirtyDayCycle.estimatedBleedingEnd, '2026-11-07');
  assert.equal(fortyDayCycle.estimatedBleedingEnd, thirtyDayCycle.estimatedBleedingEnd);
  assert.notEqual(fortyDayCycle.predictedNextStart, thirtyDayCycle.predictedNextStart);
  assert.equal(fiveDayBleeding.predictedNextStart, thirtyDayCycle.predictedNextStart);
  assert.equal(fiveDayBleeding.estimatedBleedingEnd, '2026-11-05');
  assert.equal(thirtyDayCycle.purificationDetermination, false);
  assert.equal(fiveDayBleeding.purificationDetermination, false);
});

test('returns the immediate next forecast without rolling an overdue cycle forward', () => {
  const result = predictCycle({
    lastCycleStart: '2026-01-01',
    typicalBleedingDays: 7,
    typicalCycleDays: 30,
    regularity: 'regular',
  }, CURRENT_DATE);

  assert.equal(result.predictedNextStart, '2026-01-31');
});

test('rejects fields outside the pure canonical prediction input', () => {
  assertPredictionFailure({
    ...initialInput(),
    scannerEvidence: { color: 'red' },
  }, CURRENT_DATE, 'PREDICTION_INPUT_INVALID');
});

test('clamps a one-day regular initial window to the next calendar day', () => {
  const result = predictCycle({
    lastCycleStart: '2026-11-01',
    typicalBleedingDays: 1,
    typicalCycleDays: 1,
    regularity: 'regular',
  }, CURRENT_DATE);

  assert.equal(result.windowStart, '2026-11-02');
  assert.deepEqual(result.basis.windowOffsetsDays, { min: 1, max: 3 });
});

test('clamps a one-day irregular initial window to the next calendar day', () => {
  const result = predictCycle({
    lastCycleStart: '2026-11-01',
    typicalBleedingDays: 1,
    typicalCycleDays: 1,
    regularity: 'irregular',
  }, CURRENT_DATE);

  assert.equal(result.windowStart, '2026-11-02');
  assert.deepEqual(result.basis.windowOffsetsDays, { min: 1, max: 5 });
});

test('preserves the central plus-one union above lower observed intervals', () => {
  const result = predictCycle({
    lastCycleStart: '2026-09-30',
    typicalBleedingDays: 7,
    typicalCycleDays: 90,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-31', '2026-09-30'],
  }, CURRENT_DATE);

  assert.equal(result.basis.weightedExpectedCycleDays, 40);
  assert.deepEqual(result.basis.actualIntervalsDays, [30, 30]);
  assert.deepEqual(result.basis.windowOffsetsDays, { min: 30, max: 41 });
});

test('preserves the central minus-one union below higher observed intervals', () => {
  const result = predictCycle({
    lastCycleStart: '2026-09-30',
    typicalBleedingDays: 7,
    typicalCycleDays: 1,
    regularity: 'regular',
    confirmedCycleStarts: ['2026-08-01', '2026-08-31', '2026-09-30'],
  }, CURRENT_DATE);

  assert.equal(result.basis.weightedExpectedCycleDays, 25);
  assert.deepEqual(result.basis.actualIntervalsDays, [30, 30]);
  assert.deepEqual(result.basis.windowOffsetsDays, { min: 24, max: 30 });
});

test('classifies valid early calendar years as outside the supported range', () => {
  assertPredictionFailure({
    ...initialInput(),
    lastCycleStart: '0099-12-01',
  }, CURRENT_DATE, 'PREDICTION_DATE_OUT_OF_RANGE');
  assertPredictionFailure(initialInput(), '0099-12-01', 'PREDICTION_DATE_OUT_OF_RANGE');
});

test('rejects forecasts whose derived dates would exceed four-digit ISO years', () => {
  assertPredictionFailure({
    lastCycleStart: '9999-12-31',
    typicalBleedingDays: 1,
    typicalCycleDays: 1,
    regularity: 'regular',
  }, '9999-12-31', 'PREDICTION_DATE_OUT_OF_RANGE');

  assertPredictionFailure({
    lastCycleStart: '9999-12-28',
    typicalBleedingDays: 1,
    typicalCycleDays: 1,
    regularity: 'irregular',
  }, '9999-12-31', 'PREDICTION_DATE_OUT_OF_RANGE');

  assertPredictionFailure({
    lastCycleStart: '9999-01-01',
    typicalBleedingDays: 366,
    typicalCycleDays: 1,
    regularity: 'regular',
  }, '9999-12-31', 'PREDICTION_DATE_OUT_OF_RANGE');
});
