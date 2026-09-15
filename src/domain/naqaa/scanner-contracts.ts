/**
 * @kip
 * @module naqaa-scanner
 * @layer domain
 * @owner naqaa
 * @feature K21
 * @purpose Naqaa Scanner Foundation V1 contracts. Production boundary: KIP receives
 *          DERIVED scan evidence (NaqaaScanEvidenceV1), NOT raw media. Raw images are
 *          ephemeral/on-device. Context is SEPARATE from scan evidence.
 *
 * THE SCANNER OBSERVES. KIP INTERPRETS AND DECIDES (fiqh is NOT here).
 * No religious ruling fields. UNKNOWN/UNAVAILABLE NEVER MEANS FALSE.
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

/** Group 1 — Color. */
export interface ColorEvidence {
  primaryColor?: FeatureValue<string>;
  secondaryColor?: FeatureValue<string>;
  brightness?: FeatureValue<string>;
  saturation?: FeatureValue<string>;
  contrast?: FeatureValue<string>;
  colorUniformity?: FeatureValue<string>;
  rgb?: FeatureValue<[number, number, number]>;
}

/** Group 2 — Physical, VISUALLY-ESTIMATED ONLY. Never a direct measurement. */
export interface PhysicalEvidence {
  apparentFluidity?: FeatureValue<string>;
  apparentViscosity?: FeatureValue<string>;
  apparentDensity?: FeatureValue<string>;
  wateriness?: FeatureValue<string>;
  apparentClotting?: FeatureValue<string>;
  masses?: FeatureValue<string>;
  strings?: FeatureValue<string>;
  homogeneity?: FeatureValue<string>;
}

/** Group 3 — Texture. */
export interface TextureEvidence {
  smoothness?: FeatureValue<string>;
  roughness?: FeatureValue<string>;
  granularity?: FeatureValue<string>;
  clustering?: FeatureValue<string>;
  textureUniformity?: FeatureValue<string>;
}

/** Group 4 — Spatial. */
export interface SpatialEvidence {
  stainArea?: FeatureValue<string>;
  stainShape?: FeatureValue<string>;
  droplets?: FeatureValue<string>;
  streaks?: FeatureValue<string>;
  spreadRatio?: FeatureValue<string>;
  edgeCharacteristics?: FeatureValue<string>;
  distribution?: FeatureValue<string>;
}

/** Group 5 — Quality + Confidence. Feature-level confidence lives on features. */
export interface ScanQualityEvidence {
  rating: QualityRating;
  usable: boolean;
  lightingQuality?: string;
  focusClarity?: string;
  reasons?: string[];
}

/**
 * Derived scan evidence. Raw media is NEVER part of this contract.
 * schemaVersion: 1; five groups = color / physical / texture / spatial / quality.
 * Context (cycle day, pregnancy, ...) is NOT evidence — it is separate.
 */
export interface NaqaaScanEvidenceV1 {
  schemaVersion: 1;
  evidenceId?: string;
  occurredAt: string;
  scannerVersion: string;
  color: ColorEvidence;
  physical: PhysicalEvidence;
  texture: TextureEvidence;
  spatial: SpatialEvidence;
  quality: ScanQualityEvidence;
  provenance: { scanSource: FeatureSource; note?: string };
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

/** Bounded user/case context combined WITHOUT contaminating the scan evidence. */
export interface ScannerContextUsage {
  userCount: number;
  conversationCount: number;
  caseCount: number;
}

export interface NaqaaScannerResultV1 {
  status: ScannerStatus;
  evidence?: NaqaaScanEvidenceV1;
  sufficiency: ScannerSufficiency;
  missingInformation: MissingInformation[];
  questionNeeded: boolean;
  question?: ScannerQuestion;
  scannerVersion: string;
  contextUsed: ScannerContextUsage;
  observability: { runId?: string; memoryItemsUsed: number };
}
