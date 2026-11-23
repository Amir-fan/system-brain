import { createHash } from 'node:crypto';

export type CycleRegularity = 'regular' | 'irregular' | 'unknown';

export type CyclePredictionReliability = 'initial' | 'history_based' | 'needs_more_data';

export type CyclePredictionFailureCode =
  | 'PREDICTION_INPUT_INVALID'
  | 'PREDICTION_DATE_INVALID'
  | 'PREDICTION_DATE_OUT_OF_RANGE'
  | 'PREDICTION_DATE_IN_FUTURE'
  | 'PREDICTION_NUMBER_INVALID'
  | 'PREDICTION_NUMBER_OUT_OF_RANGE'
  | 'PREDICTION_HISTORY_TOO_LONG'
  | 'PREDICTION_HISTORY_DUPLICATE'
  | 'PREDICTION_LATEST_START_MISMATCH';

export interface CyclePredictionInput {
  lastCycleStart: string;
  typicalBleedingDays: number;
  typicalCycleDays?: number;
  regularity: CycleRegularity;
  confirmedCycleStarts?: string[];
}

export interface CyclePredictionBasis {
  latestCycleStart: string;
  baselineCycleDays: number;
  usedDefaultCycleDays: boolean;
  actualIntervalsDays: number[];
  weightedExpectedCycleDays: number;
  windowOffsetsDays: {
    min: number;
    max: number;
  };
}

export interface CyclePredictionIntegration {
  contractVersion: 'naqaa-cycle-prediction-v1';
  inputFingerprint: string;
  forecast: {
    predictedNextStart: string;
    windowStart: string;
    windowEnd: string;
    reliability: CyclePredictionReliability;
  };
  estimatedBleedingEnd: string;
}

export interface CyclePredictionResult {
  predictedNextStart: string;
  windowStart: string;
  windowEnd: string;
  estimatedBleedingEnd: string;
  reliability: CyclePredictionReliability;
  basis: CyclePredictionBasis;
  integration: CyclePredictionIntegration;
  fiqhImpact: 'none';
  purificationDetermination: false;
}

export class CyclePredictionFailure extends Error {
  readonly code: CyclePredictionFailureCode;

  constructor(code: CyclePredictionFailureCode, message: string) {
    super(message);
    this.name = 'CyclePredictionFailure';
    this.code = code;
  }
}

const CONTRACT_VERSION = 'naqaa-cycle-prediction-v1' as const;
const DEFAULT_CYCLE_DAYS = 28;
const MIN_SUPPORTED_DATE = '1900-01-01';
const MAX_SUPPORTED_YEAR = 9999;
const MIN_DURATION_DAYS = 1;
const MAX_DURATION_DAYS = 366;
const MAX_CONFIRMED_STARTS = 120;
const MILLISECONDS_PER_DAY = 86_400_000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const REGULARITIES: readonly CycleRegularity[] = ['regular', 'irregular', 'unknown'];
const INPUT_KEYS = new Set([
  'lastCycleStart',
  'typicalBleedingDays',
  'typicalCycleDays',
  'regularity',
  'confirmedCycleStarts',
]);

interface ParsedDate {
  source: string;
  utcMilliseconds: number;
}

interface ValidatedInput {
  lastCycleStart: string;
  lastCycleStartUtc: number;
  typicalBleedingDays: number;
  typicalCycleDays?: number;
  regularity: CycleRegularity;
  confirmedCycleStarts: string[];
  confirmedCycleStartUtc: number[];
}

function fail(code: CyclePredictionFailureCode, message: string): never {
  throw new CyclePredictionFailure(code, message);
}

function parseIsoDate(value: unknown, fieldName: string): ParsedDate {
  if (typeof value !== 'string') {
    fail('PREDICTION_DATE_INVALID', `${fieldName} must be a strict ISO calendar date`);
  }

  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    fail('PREDICTION_DATE_INVALID', `${fieldName} must be a strict ISO calendar date`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const utcMilliseconds = date.getTime();

  if (!Number.isFinite(utcMilliseconds)
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day) {
    fail('PREDICTION_DATE_INVALID', `${fieldName} must be a real ISO calendar date`);
  }

  if (value < MIN_SUPPORTED_DATE) {
    fail('PREDICTION_DATE_OUT_OF_RANGE', `${fieldName} is outside the supported date range`);
  }

  return { source: value, utcMilliseconds };
}

function validateDuration(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail('PREDICTION_NUMBER_INVALID', `${fieldName} must be a finite integer`);
  }
  if (value < MIN_DURATION_DAYS || value > MAX_DURATION_DAYS) {
    fail('PREDICTION_NUMBER_OUT_OF_RANGE', `${fieldName} is outside the supported range`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInput(input: unknown, currentDate: unknown): ValidatedInput {
  if (!isRecord(input) || Object.keys(input).some((key) => !INPUT_KEYS.has(key))) {
    fail('PREDICTION_INPUT_INVALID', 'Prediction input has an invalid shape');
  }

  if (!('lastCycleStart' in input)
    || !('typicalBleedingDays' in input)
    || !('regularity' in input)
    || typeof input.regularity !== 'string'
    || !REGULARITIES.includes(input.regularity as CycleRegularity)) {
    fail('PREDICTION_INPUT_INVALID', 'Prediction input is missing a required field');
  }

  const parsedCurrentDate = parseIsoDate(currentDate, 'currentDate');
  const parsedLastCycleStart = parseIsoDate(input.lastCycleStart, 'lastCycleStart');
  if (parsedLastCycleStart.utcMilliseconds > parsedCurrentDate.utcMilliseconds) {
    fail('PREDICTION_DATE_IN_FUTURE', 'lastCycleStart cannot be after currentDate');
  }

  const typicalBleedingDays = validateDuration(input.typicalBleedingDays, 'typicalBleedingDays');
  const typicalCycleDays = input.typicalCycleDays === undefined
    ? undefined
    : validateDuration(input.typicalCycleDays, 'typicalCycleDays');

  if (input.confirmedCycleStarts !== undefined && !Array.isArray(input.confirmedCycleStarts)) {
    fail('PREDICTION_INPUT_INVALID', 'confirmedCycleStarts must be an array');
  }

  const suppliedStarts = input.confirmedCycleStarts ?? [];
  if (suppliedStarts.length > MAX_CONFIRMED_STARTS) {
    fail('PREDICTION_HISTORY_TOO_LONG', 'confirmedCycleStarts exceeds the supported limit');
  }

  const seen = new Set<string>();
  const parsedStarts = suppliedStarts.map((start, index) => {
    const parsed = parseIsoDate(start, `confirmedCycleStarts[${index}]`);
    if (parsed.utcMilliseconds > parsedCurrentDate.utcMilliseconds) {
      fail('PREDICTION_DATE_IN_FUTURE', 'confirmed cycle starts cannot be after currentDate');
    }
    if (seen.has(parsed.source)) {
      fail('PREDICTION_HISTORY_DUPLICATE', 'confirmedCycleStarts contains a duplicate date');
    }
    seen.add(parsed.source);
    return parsed;
  });

  parsedStarts.sort((left, right) => left.utcMilliseconds - right.utcMilliseconds);
  if (parsedStarts.length > 0 && parsedStarts.at(-1)?.source !== parsedLastCycleStart.source) {
    fail('PREDICTION_LATEST_START_MISMATCH', 'lastCycleStart must match the latest confirmed start');
  }

  return {
    lastCycleStart: parsedLastCycleStart.source,
    lastCycleStartUtc: parsedLastCycleStart.utcMilliseconds,
    typicalBleedingDays,
    typicalCycleDays,
    regularity: input.regularity as CycleRegularity,
    confirmedCycleStarts: parsedStarts.map((start) => start.source),
    confirmedCycleStartUtc: parsedStarts.map((start) => start.utcMilliseconds),
  };
}

function formatUtcDate(utcMilliseconds: number): string {
  const date = new Date(utcMilliseconds);
  const numericYear = date.getUTCFullYear();
  if (!Number.isFinite(utcMilliseconds)
    || !Number.isFinite(date.getTime())
    || numericYear < 1900
    || numericYear > MAX_SUPPORTED_YEAR) {
    fail('PREDICTION_DATE_OUT_OF_RANGE', 'Derived prediction date is outside the supported range');
  }
  const year = String(numericYear).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addUtcDays(utcMilliseconds: number, days: number): string {
  return formatUtcDate(utcMilliseconds + days * MILLISECONDS_PER_DAY);
}

function fingerprintInput(input: ValidatedInput): string {
  const canonicalInput = {
    contractVersion: CONTRACT_VERSION,
    lastCycleStart: input.lastCycleStart,
    typicalBleedingDays: input.typicalBleedingDays,
    typicalCycleDays: input.typicalCycleDays ?? null,
    regularity: input.regularity,
    confirmedCycleStarts: input.confirmedCycleStarts,
  };
  const digest = createHash('sha256').update(JSON.stringify(canonicalInput), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function calculateIntervals(startDatesUtc: readonly number[]): number[] {
  const intervals: number[] = [];
  for (let index = 1; index < startDatesUtc.length; index += 1) {
    intervals.push((startDatesUtc[index] - startDatesUtc[index - 1]) / MILLISECONDS_PER_DAY);
  }
  return intervals;
}

function calculateExpectedCycleDays(baselineCycleDays: number, intervals: readonly number[]): number {
  let weightedTotal = baselineCycleDays;
  let totalWeight = 1;

  intervals.forEach((interval, index) => {
    const weight = index + 2;
    weightedTotal += interval * weight;
    totalWeight += weight;
  });

  return Math.round(weightedTotal / totalWeight);
}

function calculateWindowOffsets(
  expectedCycleDays: number,
  intervals: readonly number[],
  usedDefaultCycleDays: boolean,
  regularity: CycleRegularity,
): { min: number; max: number } {
  let min: number;
  let max: number;

  if (intervals.length === 0) {
    const halfWidthDays = usedDefaultCycleDays ? 4 : 2;
    min = expectedCycleDays - halfWidthDays;
    max = expectedCycleDays + halfWidthDays;
  } else if (intervals.length === 1) {
    min = expectedCycleDays - 1;
    max = expectedCycleDays + 1;
  } else {
    min = Math.min(...intervals, expectedCycleDays - 1);
    max = Math.max(...intervals, expectedCycleDays + 1);
  }

  if (regularity === 'irregular') {
    min = Math.min(min, expectedCycleDays - 4);
    max = Math.max(max, expectedCycleDays + 4);
  }

  return { min: Math.max(1, min), max };
}

export function predictCycle(input: CyclePredictionInput, currentDate: string): CyclePredictionResult {
  const validated = validateInput(input, currentDate);
  const usedDefaultCycleDays = validated.typicalCycleDays === undefined;
  const baselineCycleDays = validated.typicalCycleDays ?? DEFAULT_CYCLE_DAYS;
  const actualIntervalsDays = calculateIntervals(validated.confirmedCycleStartUtc);
  const weightedExpectedCycleDays = calculateExpectedCycleDays(baselineCycleDays, actualIntervalsDays);
  const windowOffsetsDays = calculateWindowOffsets(
    weightedExpectedCycleDays,
    actualIntervalsDays,
    usedDefaultCycleDays,
    validated.regularity,
  );
  const reliability: CyclePredictionReliability = actualIntervalsDays.length > 0
    ? 'history_based'
    : usedDefaultCycleDays ? 'needs_more_data' : 'initial';
  const predictedNextStart = addUtcDays(validated.lastCycleStartUtc, weightedExpectedCycleDays);
  const windowStart = addUtcDays(validated.lastCycleStartUtc, windowOffsetsDays.min);
  const windowEnd = addUtcDays(validated.lastCycleStartUtc, windowOffsetsDays.max);
  const estimatedBleedingEnd = addUtcDays(validated.lastCycleStartUtc, validated.typicalBleedingDays - 1);

  return {
    predictedNextStart,
    windowStart,
    windowEnd,
    estimatedBleedingEnd,
    reliability,
    basis: {
      latestCycleStart: validated.lastCycleStart,
      baselineCycleDays,
      usedDefaultCycleDays,
      actualIntervalsDays,
      weightedExpectedCycleDays,
      windowOffsetsDays,
    },
    integration: {
      contractVersion: CONTRACT_VERSION,
      inputFingerprint: fingerprintInput(validated),
      forecast: {
        predictedNextStart,
        windowStart,
        windowEnd,
        reliability,
      },
      estimatedBleedingEnd,
    },
    fiqhImpact: 'none',
    purificationDetermination: false,
  };
}
