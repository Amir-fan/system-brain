/**
 * @kip
 * @module naqaa-scanner
 * @layer domain
 * @owner naqaa
 * @feature K21
 * @purpose Naqaa Scanner Foundation V1 contracts. Domain contracts ONLY — the generic
 *          Core, Memory, Understanding and Skills Runtime know nothing about these.
 *
 * Boundaries: SCAN OBSERVATION != FIQH DECISION. This module contains NO religious
 * ruling fields (hayd/istihada/nifas/purity/prayer/fasting). UNKNOWN != FALSE: an
 * `unavailable` feature has a null value, never false/0/"".
 */

export type FeatureStatus = 'observed' | 'inferred' | 'user_provided' | 'unavailable';
export type FeatureSource = 'vision' | 'memory' | 'user';

/** Minimal provenance contract for every meaningful feature. */
export interface FeatureValue<T = unknown> {
  value: T | null;
  status: FeatureStatus;
  confidence?: number;
  source: FeatureSource;
  method?: string;
  unit?: string;
}

export type QualityRating = 'usable' | 'limited' | 'unusable';

export interface ScanQuality {
  rating: QualityRating;
  usable: boolean;
  reasons?: string[];
}

export interface ColorFeatures {
  dominantColor?: FeatureValue<string>;
  hue?: FeatureValue<string>;
  saturation?: FeatureValue<string>;
  brightness?: FeatureValue<string>;
  contrast?: FeatureValue<string>;
  colorUniformity?: FeatureValue<string>;
}

export interface PhysicalFeatures {
  /** Non-visual properties an image cannot reliably MEASURE — never `observed`. */
  viscosity?: FeatureValue<string>;
  density?: FeatureValue<string>;
  fluidity?: FeatureValue<string>;
  wateriness?: FeatureValue<string>;
  /** Visually observable when the model genuinely sees them. */
  clotting?: FeatureValue<string>;
  homogeneity?: FeatureValue<string>;
}

export interface TextureFeatures {
  smoothness?: FeatureValue<string>;
  granularity?: FeatureValue<string>;
  clustering?: FeatureValue<string>;
  textureUniformity?: FeatureValue<string>;
}

export interface SpatialFeatures {
  stainArea?: FeatureValue<string>;
  stainShape?: FeatureValue<string>;
  droplets?: FeatureValue<string>;
  spreadRatio?: FeatureValue<string>;
  edgeThickness?: FeatureValue<string>;
}

export interface ContextualFeatures {
  occurredAt?: FeatureValue<string>;
  cycleDay?: FeatureValue<string>;
  pregnancyStatus?: FeatureValue<string>;
  duration?: FeatureValue<string>;
}

export interface NaqaaScanObservationV1 {
  schemaVersion: 1;
  observationId?: string;
  occurredAt: string;
  scannerVersion: string;
  color: ColorFeatures;
  physical: PhysicalFeatures;
  texture: TextureFeatures;
  spatial: SpatialFeatures;
  contextual: ContextualFeatures;
  quality: ScanQuality;
  provenance: { scanSource: FeatureSource; modelInfo?: { provider?: string; model?: string } };
}

export type ScannerStatus = 'completed' | 'needs_information' | 'unusable' | 'failed';
export type ScannerSufficiency = 'sufficient' | 'insufficient' | 'unusable';

export interface MissingInformation {
  key: string;
  reason: string;
  importance: 'required' | 'optional';
}

export interface ScannerQuestion {
  key: string;
  question: string;
  reason: string;
}

export interface NaqaaScannerResultV1 {
  status: ScannerStatus;
  observation?: NaqaaScanObservationV1;
  sufficiency: ScannerSufficiency;
  missingInformation: MissingInformation[];
  questionNeeded: boolean;
  question?: ScannerQuestion;
  scannerVersion: string;
  modelInfo?: { provider?: string; model?: string };
  observability: { runId?: string; visionCalls: number; memoryItemsUsed: number };
}
