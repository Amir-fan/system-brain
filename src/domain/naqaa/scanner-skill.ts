/**
 * @kip
 * @module naqaa-scanner
 * @layer domain
 * @owner naqaa
 * @feature K21
 * @purpose Naqaa Scanner Skill v1 — production boundary: receives DERIVED evidence
 *          (NaqaaScanEvidenceV1), never raw media. Validates/normalizes evidence,
 *          preserves provenance, combines bounded context SEPARATELY, assesses
 *          scanner-level sufficiency and returns NaqaaScannerResultV1.
 *
 * THE SCANNER OBSERVES. KIP INTERPRETS AND DECIDES. No fiqh. No raw media stored.
 * No learning dataset. UNKNOWN != FALSE.
 */

import type { SkillDefinition, SkillExecutionContext } from '../../core/skill/skill.ts';
import { SkillFailure } from '../../core/skill/skill.ts';
import type { MemoryReference } from '../../core/understanding/understanding.ts';
import type {
  ColorEvidence,
  FeatureSource,
  FeatureValue,
  FeatureStatus,
  NaqaaScanEvidenceV1,
  NaqaaScannerResultV1,
  PhysicalEvidence,
  QualityRating,
  SpatialEvidence,
  TextureEvidence,
} from './scanner-contracts.ts';

const SCANNER_VERSION = 'naqaa.scanner@1';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const RFC3339_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/;
const LEAP_SECOND_DATES = new Set([
  '1972-06-30', '1972-12-31', '1973-12-31', '1974-12-31', '1975-12-31', '1976-12-31',
  '1977-12-31', '1978-12-31', '1979-12-31', '1981-06-30', '1982-06-30', '1983-06-30',
  '1985-06-30', '1987-12-31', '1989-12-31', '1990-12-31', '1992-06-30', '1993-06-30',
  '1994-06-30', '1995-12-31', '1997-06-30', '1998-12-31', '2005-12-31', '2008-12-31',
  '2012-06-30', '2015-06-30', '2016-12-31',
]);

/** Accept only real RFC 3339 wall-clock values carrying an explicit offset. */
function isExplicitOffsetTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = RFC3339_WITH_ZONE.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone, offsetSign, offsetHour, offsetMinute] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;

  // Validate the source wall-clock components before applying its offset. Date.parse alone
  // accepts rollover values on some runtimes (for example February 30).
  const validationSecond = second === '60' ? '59' : second;
  const wallClock = new Date(`${year}-${month}-${day}T${hour}:${minute}:${validationSecond}.000Z`);
  if (!Number.isFinite(wallClock.getTime())) return false;
  if (wallClock.getUTCFullYear() !== Number(year)
    || wallClock.getUTCMonth() + 1 !== Number(month)
    || wallClock.getUTCDate() !== Number(day)
    || wallClock.getUTCHours() !== Number(hour)
    || wallClock.getUTCMinutes() !== Number(minute)
    || wallClock.getUTCSeconds() !== Number(validationSecond)) return false;

  if (second === '60') {
    const offset = offsetHour === undefined
      ? 0
      : (offsetSign === '-' ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute));
    const utc = new Date(wallClock.getTime() - offset * 60_000);
    const utcDate = `${String(utc.getUTCFullYear()).padStart(4, '0')}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
    return utc.getUTCHours() === 23 && utc.getUTCMinutes() === 59 && utc.getUTCSeconds() === 59
      && LEAP_SECOND_DATES.has(utcDate);
  }

  return Number.isFinite(Date.parse(value));
}

const STATUSES: readonly FeatureStatus[] = ['observed', 'inferred', 'user_provided', 'unavailable'];
const isStatus = (s: unknown): s is FeatureStatus => typeof s === 'string' && (STATUSES as readonly string[]).includes(s);
const SOURCES: readonly FeatureSource[] = ['vision', 'memory', 'user'];
const isSource = (source: unknown): source is FeatureSource => typeof source === 'string' && (SOURCES as readonly string[]).includes(source);
const COLOR_KEYS = ['primaryColor', 'secondaryColor', 'brightness', 'saturation', 'contrast', 'colorUniformity', 'rgb'] as const;
const PHYSICAL_KEYS = ['apparentFluidity', 'apparentViscosity', 'apparentDensity', 'wateriness', 'apparentClotting', 'masses', 'strings', 'homogeneity'] as const;
const TEXTURE_KEYS = ['smoothness', 'roughness', 'granularity', 'clustering', 'textureUniformity'] as const;
const SPATIAL_KEYS = ['stainArea', 'stainShape', 'droplets', 'streaks', 'spreadRatio', 'edgeCharacteristics', 'distribution'] as const;
const RAW_MEDIA_DATA_URL = /data:(?:image\/|audio\/|video\/|application\/octet-stream(?:[;,]|$))/i;
const RAW_MEDIA_WRAPPER = /\b(?:base64|blob|media|raw(?:image|audio|video|media)?)\s*["']?\s*(?::|=|:\/\/)/i;
const RAW_MEDIA_OBJECT = /[\[{][\s\S]{0,120}["']?(?:base64|blob|media|raw(?:image|audio|video|media)?)["']?\s*:/i;
const BINARY_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/;

/** Project only ordinary bounded scalar text; recognizable media/binary wrappers are not evidence text. */
function safeScalarText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const normalized = value.normalize('NFKC');
  if (RAW_MEDIA_DATA_URL.test(normalized) || RAW_MEDIA_WRAPPER.test(normalized) || RAW_MEDIA_OBJECT.test(normalized) || BINARY_TEXT.test(normalized)) return undefined;
  return value.slice(0, maxLength);
}

/** Normalize a raw feature record from the evidence payload into a safe FeatureValue. */
function normFeature(raw: unknown, rgb = false): FeatureValue<string | [number, number, number]> | undefined {
  if (!isObj(raw)) return undefined;
  const status = isStatus(raw.status) ? raw.status : 'unavailable';
  const source = isSource(raw.source) ? raw.source : 'vision';
  if (status === 'unavailable') return {
    value: null, status, source,
    method: safeScalarText(raw.method, 80) ?? 'unknown',
  };
  const value = rgb
    ? (Array.isArray(raw.value) && raw.value.length === 3 && raw.value.every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0 && part <= 255)
        ? raw.value as [number, number, number]
        : undefined)
    : safeScalarText(raw.value, 200);
  if (value === undefined) return undefined;
  return {
    value,
    status,
    ...(typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1 ? { confidence: raw.confidence } : {}),
    source,
    ...(safeScalarText(raw.method, 80) ? { method: safeScalarText(raw.method, 80)! } : {}),
    ...(safeScalarText(raw.unit, 40) ? { unit: safeScalarText(raw.unit, 40)! } : {}),
  };
}

/** Map an evidence group object -> normalized features. */
function group(raw: unknown, keys: readonly string[]): Record<string, FeatureValue<string | [number, number, number]>> {
  if (!isObj(raw)) return {};
  const out: Record<string, FeatureValue<string | [number, number, number]>> = {};
  for (const key of keys) {
    const feature = normFeature(raw[key], key === 'rgb');
    if (feature) out[key] = feature;
  }
  return out;
}

/** Apparent physical props are visually-estimated: never `observed` (not a direct measurement). */
function normalizePhysical(raw: unknown): PhysicalEvidence {
  const g = group(raw, PHYSICAL_KEYS);
  const out: PhysicalEvidence = {};
  for (const [k, f] of Object.entries(g)) {
    if (!f) continue;
    if (f.status === 'observed') f.status = 'inferred';
    out[k as keyof PhysicalEvidence] = f as FeatureValue<string>;
  }
  return out;
}

function ratingOf(raw: unknown): QualityRating {
  if (!isObj(raw)) return 'usable';
  const r = raw.rating;
  if (r === 'limited') return 'limited';
  if (r === 'unusable') return 'unusable';
  return 'usable';
}

function memCycleDay(memory: MemoryReference[]): string | undefined {
  const m = memory.find((x) => x.memoryKey === 'cycle_day');
  const v = m && (m.payload as Record<string, unknown>).value;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export const naqaaScanner: SkillDefinition = {
  id: 'naqaa.scanner',
  version: 1,
  description: 'Validate derived Naqaa scan evidence, preserve provenance, combine bounded context, assess scanner sufficiency (no fiqh).',
  requirements: { understanding: false, memory: true, knowledge: false, model: false },

  validateInput(input: unknown) {
    if (!isObj(input)) return { ok: false, message: 'input must be an object' };
    const ev = (input.evidence ?? null) as NaqaaScanEvidenceV1 | null;
    if (!isObj(ev)) return { ok: false, message: 'evidence (NaqaaScanEvidenceV1) is required' };
    if (!isExplicitOffsetTimestamp(ev.occurredAt)) return { ok: false, message: 'evidence.occurredAt must be an RFC 3339 timestamp with an explicit offset' };
    for (const g of ['color', 'physical', 'texture', 'spatial', 'quality']) {
      if (!isObj(ev[g as keyof NaqaaScanEvidenceV1])) return { ok: false, message: `evidence group '${g}' is required` };
    }
    return { ok: true };
  },

  validateOutput(output: unknown) {
    if (!isObj(output)) return { ok: false, message: 'output must be an object' };
    if (typeof output.status !== 'string' || typeof output.sufficiency !== 'string') {
      return { ok: false, message: 'status/sufficiency required' };
    }
    return { ok: true };
  },

  async execute(ctx: SkillExecutionContext): Promise<NaqaaScannerResultV1> {
    const payload = isObj(ctx.input) ? ctx.input : {};
    const rawEv = payload.evidence as NaqaaScanEvidenceV1;
    const userCtx = isObj(payload.context) ? (payload.context as Record<string, unknown>) : {};
    const memory: MemoryReference[] = ctx.memory ?? [];
    const runId = crypto.randomUUID();

    const evidence: NaqaaScanEvidenceV1 = {
      schemaVersion: 1,
      ...(safeScalarText(rawEv.evidenceId, 128) ? { evidenceId: safeScalarText(rawEv.evidenceId, 128)! } : {}),
      occurredAt: rawEv.occurredAt,
      scannerVersion: safeScalarText(rawEv.scannerVersion, 120) ?? 'naqaa.ondevice@1',
      color: group(rawEv.color, COLOR_KEYS) as ColorEvidence,
      physical: normalizePhysical(rawEv.physical),
      texture: group(rawEv.texture, TEXTURE_KEYS) as TextureEvidence,
      spatial: group(rawEv.spatial, SPATIAL_KEYS) as SpatialEvidence,
      quality: {
        rating: ratingOf(rawEv.quality),
        usable: ratingOf(rawEv.quality) !== 'unusable',
        ...(isObj(rawEv.quality) && safeScalarText(rawEv.quality.lightingQuality, 80) ? { lightingQuality: safeScalarText(rawEv.quality.lightingQuality, 80)! } : {}),
        ...(isObj(rawEv.quality) && safeScalarText(rawEv.quality.focusClarity, 80) ? { focusClarity: safeScalarText(rawEv.quality.focusClarity, 80)! } : {}),
        ...(isObj(rawEv.quality) && Array.isArray(rawEv.quality.reasons)
          ? { reasons: rawEv.quality.reasons.map((reason) => safeScalarText(reason, 120)).filter((reason): reason is string => reason !== undefined).slice(0, 8) }
          : {}),
      },
      provenance: {
        scanSource: isObj(rawEv.provenance) && isSource(rawEv.provenance.scanSource) ? rawEv.provenance.scanSource : 'vision',
        ...(isObj(rawEv.provenance) && safeScalarText(rawEv.provenance.note, 200) ? { note: safeScalarText(rawEv.provenance.note, 200)! } : {}),
      },
    };

    // I: unusable scan quality -> unusable safely (no fabricated evidence).
    if (evidence.quality.rating === 'unusable') {
      return {
        status: 'unusable', sufficiency: 'unusable', missingInformation: [], questionNeeded: false,
        scannerVersion: SCANNER_VERSION, contextUsed: { userCount: memory.filter((m) => m.scope === 'user').length, conversationCount: 0, caseCount: 0 },
        observability: { runId, memoryItemsUsed: memory.length },
      };
    }

    // Required contextual anchor: cycle day from user context or bounded memory (NOT evidence).
    const cycleDay = typeof userCtx.cycleDay === 'string' && userCtx.cycleDay ? userCtx.cycleDay : memCycleDay(memory);
    const missingInformation: NaqaaScannerResultV1['missingInformation'] = [];
    if (!cycleDay) {
      missingInformation.push({ key: 'cycle_day', reason: 'required_to_contextualize_the_scan', importance: 'required' });
    }
    const sufficient = missingInformation.length === 0;

    return {
      status: sufficient ? 'completed' : 'needs_information',
      evidence,
      sufficiency: sufficient ? 'sufficient' : 'insufficient',
      missingInformation,
      questionNeeded: missingInformation.length > 0,
      ...(missingInformation.length > 0
        ? { question: { key: 'cycle_day', question: 'في أي يوم من الدورة تم هذا الفحص؟', reason: 'required_for_scanner_context' } }
        : {}),
      scannerVersion: SCANNER_VERSION,
      contextUsed: { userCount: memory.filter((m) => m.scope === 'user').length, conversationCount: memory.filter((m) => m.scope === 'conversation').length, caseCount: memory.filter((m) => m.scope === 'case').length },
      observability: { runId, memoryItemsUsed: memory.length },
    };
  },
};
