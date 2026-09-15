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
  FeatureStatus,
  NaqaaScanEvidenceV1,
  NaqaaScannerResultV1,
  PhysicalEvidence,
  QualityRating,
} from './scanner-contracts.ts';

const SCANNER_VERSION = 'naqaa.scanner@1';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const STATUSES: readonly FeatureStatus[] = ['observed', 'inferred', 'user_provided', 'unavailable'];
const isStatus = (s: unknown): s is FeatureStatus => typeof s === 'string' && (STATUSES as readonly string[]).includes(s);

/** Normalize a raw feature record from the evidence payload into a safe FeatureValue. */
function normFeature(raw: unknown): NaqaaScanEvidenceV1['color']['primaryColor'] {
  if (!isObj(raw)) return undefined;
  const status = isStatus(raw.status) ? raw.status : 'unavailable';
  if (status === 'unavailable') return { value: null, status, source: (raw.source as never) ?? 'vision', method: (raw.method as string) ?? 'unknown' };
  return {
    value: (raw.value as string) ?? null,
    status,
    ...(typeof raw.confidence === 'number' ? { confidence: raw.confidence } : {}),
    source: (raw.source as never) ?? 'vision',
    ...(typeof raw.method === 'string' ? { method: raw.method } : {}),
    ...(typeof raw.unit === 'string' ? { unit: raw.unit } : {}),
  };
}

/** Map an evidence group object -> normalized features. */
function group(raw: unknown): Record<string, NaqaaScanEvidenceV1['color']['primaryColor']> {
  if (!isObj(raw)) return {};
  const out: Record<string, NaqaaScanEvidenceV1['color']['primaryColor']> = {};
  for (const k of Object.keys(raw)) out[k] = normFeature(raw[k]);
  return out;
}

/** Apparent physical props are visually-estimated: never `observed` (not a direct measurement). */
function normalizePhysical(raw: unknown): PhysicalEvidence {
  const g = group(raw);
  const out: PhysicalEvidence = {};
  for (const [k, f] of Object.entries(g)) {
    if (!f) continue;
    if (f.status === 'observed') f.status = 'inferred';
    out[k as keyof PhysicalEvidence] = f;
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
      ...(rawEv.evidenceId ? { evidenceId: rawEv.evidenceId } : {}),
      occurredAt: typeof rawEv.occurredAt === 'string' ? rawEv.occurredAt : new Date().toISOString(),
      scannerVersion: typeof rawEv.scannerVersion === 'string' ? rawEv.scannerVersion : 'naqaa.ondevice@1',
      color: group(rawEv.color),
      physical: normalizePhysical(rawEv.physical),
      texture: group(rawEv.texture),
      spatial: group(rawEv.spatial),
      quality: { rating: ratingOf(rawEv.quality), usable: ratingOf(rawEv.quality) !== 'unusable' },
      provenance: isObj(rawEv.provenance) ? (rawEv.provenance as NaqaaScanEvidenceV1['provenance']) : { scanSource: 'vision' },
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
