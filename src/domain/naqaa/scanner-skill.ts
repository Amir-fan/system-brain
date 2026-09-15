/**
 * @kip
 * @module naqaa-scanner
 * @layer domain
 * @owner naqaa
 * @feature K21
 * @purpose Naqaa Scanner Skill v1 — the first real domain Skill. Runs through the K20
 *          Skills Runtime. Transforms scan input + bounded context into a structured
 *          NaqaaScanObservationV1, assesses scanner-level sufficiency, identifies
 *          missing required information and returns NaqaaScannerResultV1.
 *
 * NEVER makes fiqh decisions. NEVER writes scan features to Memory. Uses the real
 * vision path: Skill -> Model capability -> Model Gateway -> vision_scan assignment.
 */

import type { SkillDefinition, SkillExecutionContext } from '../../core/skill/skill.ts';
import { SkillFailure } from '../../core/skill/skill.ts';
import type { MemoryReference } from '../../core/understanding/understanding.ts';
import type {
  FeatureValue,
  NaqaaScanObservationV1,
  NaqaaScannerResultV1,
  PhysicalFeatures,
  QualityRating,
} from './scanner-contracts.ts';

const SCANNER_VERSION = 'naqaa.scanner@1';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

interface MediaInput { dataUrl: string; mimeType?: string }
interface ContextInput { cycleDay?: string; pregnancyStatus?: string; occurredAt?: string }

const VISION_PROMPT =
  'Analyze this menstrual pad image. Return ONLY a compact JSON object, no other text. ' +
  'Report only what is genuinely visible in the image. Shape: ' +
  '{"quality":{"rating":"usable|limited|unusable","reasons":["..."]},"color":{"dominantColor":"...","hue":"...","saturation":"...","brightness":"...","colorUniformity":"..."},' +
  '"physical":{"clotting":"...|null"},"texture":{"smoothness":"...","granularity":"..."},' +
  '"spatial":{"stainArea":"...","stainShape":"...","spreadRatio":"..."}} ' +
  'Do NOT claim viscosity, density, fluidity, wateriness, pregnancy, or cycle day from the image — those are unknown from a photo. ' +
  'If the image is too dark/bright/blurred/insufficient, set quality.rating to unusable with a reason.';

function jsonFromModel(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'vision output not JSON');
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!isObj(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    throw new SkillFailure('SKILL_INVALID_OUTPUT', 'malformed vision output');
  }
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function visionFeature(key: string, raw: Record<string, unknown>): FeatureValue<string> | undefined {
  const value = asStr(raw[key]);
  return value ? { value, status: 'observed', source: 'vision', method: 'vision_model' } : undefined;
}

/** Image-only cannot measure these: always unavailable (value null), never observed. */
function nonVisualPhysical(): PhysicalFeatures {
  return {
    viscosity: { value: null, status: 'unavailable', source: 'vision', method: 'image_only', unit: 'n/a' },
    density: { value: null, status: 'unavailable', source: 'vision', method: 'image_only', unit: 'n/a' },
    fluidity: { value: null, status: 'unavailable', source: 'vision', method: 'image_only', unit: 'n/a' },
    wateriness: { value: null, status: 'unavailable', source: 'vision', method: 'image_only', unit: 'n/a' },
  };
}

function memFeature(m: MemoryReference, key: string): FeatureValue<string> | undefined {
  const v = (m.payload as Record<string, unknown>).value;
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return { value: v, status: 'user_provided', source: 'memory', method: 'memory' };
}

export const naqaaScanner: SkillDefinition = {
  id: 'naqaa.scanner',
  version: 1,
  description: 'Analyze a pad scan, structure the observation, assess scanner sufficiency (no fiqh ruling).',
  requirements: { understanding: false, memory: true, knowledge: false, model: true },

  validateInput(input: unknown) {
    if (!isObj(input)) return { ok: false, message: 'input must be an object' };
    const media = (input.media ?? null) as MediaInput | null;
    if (!isObj(media) || typeof media.dataUrl !== 'string' || !media.dataUrl.startsWith('data:image/')) {
      return { ok: false, message: 'media.dataUrl (data:image/...) is required' };
    }
    return { ok: true };
  },

  validateOutput(output: unknown) {
    if (!isObj(output)) return { ok: false, message: 'output must be an object' };
    if (typeof output.status !== 'string' || typeof output.sufficiency !== 'string') {
      return { ok: false, message: 'status/sufficiency required' };
    }
    if (output.observation) {
      const o = output.observation as NaqaaScanObservationV1;
      if (!o.color || !o.physical || !o.texture || !o.spatial || !o.contextual) {
        return { ok: false, message: 'observation must have all five groups' };
      }
    }
    return { ok: true };
  },

  async execute(ctx: SkillExecutionContext): Promise<NaqaaScannerResultV1> {
    const payload = isObj(ctx.input) ? ctx.input : {};
    const media = payload.media as MediaInput;
    const userCtx = (payload.context ?? {}) as ContextInput;
    const memory: MemoryReference[] = ctx.memory ?? [];
    const model = ctx.model;
    if (!model) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'model capability missing');

    const occurredAt = userCtx.occurredAt ?? new Date().toISOString();
    const runId = crypto.randomUUID();

    // One vision call through the KIP Model Gateway (vision_scan workload).
    const vision = await model.generateText({
      workload: 'vision_scan',
      parts: [
        { type: 'text', text: VISION_PROMPT },
        { type: 'image', dataUrl: media.dataUrl },
      ],
    });
    const raw = jsonFromModel(vision.text);
    const qualityObj = isObj(raw.quality) ? raw.quality : {};
    const rating = (asStr(qualityObj.rating) === 'limited' ? 'limited' : asStr(qualityObj.rating) === 'unusable' ? 'unusable' : 'usable') as QualityRating;

    // UNUSABLE media -> no fabricated features.
    if (rating === 'unusable') {
      const result: NaqaaScannerResultV1 = {
        status: 'unusable', sufficiency: 'unusable', missingInformation: [], questionNeeded: false,
        scannerVersion: SCANNER_VERSION, modelInfo: { provider: vision.provider, model: vision.model },
        observability: { runId, visionCalls: 1, memoryItemsUsed: memory.length },
      };
      return result;
    }

    // Vision-derived groups (observed where genuinely visible).
    const color = {
      dominantColor: visionFeature('dominantColor', raw.color as Record<string, unknown>),
      hue: visionFeature('hue', raw.color as Record<string, unknown>),
      saturation: visionFeature('saturation', raw.color as Record<string, unknown>),
      brightness: visionFeature('brightness', raw.color as Record<string, unknown>),
      colorUniformity: visionFeature('colorUniformity', raw.color as Record<string, unknown>),
    };
    const physRaw = (isObj(raw.physical) ? raw.physical : {}) as Record<string, unknown>;
    const physical: PhysicalFeatures = {
      ...nonVisualPhysical(),
      ...(asStr(physRaw.clotting) ? { clotting: visionFeature('clotting', physRaw) } : {}),
      ...(asStr(physRaw.homogeneity) ? { homogeneity: visionFeature('homogeneity', physRaw) } : {}),
    };
    const texRaw = (isObj(raw.texture) ? raw.texture : {}) as Record<string, unknown>;
    const texture = {
      smoothness: visionFeature('smoothness', texRaw),
      granularity: visionFeature('granularity', texRaw),
      textureUniformity: visionFeature('textureUniformity', texRaw),
    };
    const spaRaw = (isObj(raw.spatial) ? raw.spatial : {}) as Record<string, unknown>;
    const spatial = {
      stainArea: visionFeature('stainArea', spaRaw),
      stainShape: visionFeature('stainShape', spaRaw),
      spreadRatio: visionFeature('spreadRatio', spaRaw),
    };

    // Contextual: user-provided (source user) then memory (source memory). Never vision.
    const contextual: NaqaaScanObservationV1['contextual'] = {
      occurredAt: { value: occurredAt, status: 'user_provided', source: 'user', method: 'request' },
      ...(userCtx.cycleDay ? { cycleDay: { value: userCtx.cycleDay, status: 'user_provided', source: 'user' } } : {}),
      ...(userCtx.pregnancyStatus ? { pregnancyStatus: { value: userCtx.pregnancyStatus, status: 'user_provided', source: 'user' } } : {}),
    };
    for (const m of memory) {
      if (m.memoryKey === 'cycle_day' && !contextual.cycleDay) contextual.cycleDay = memFeature(m, 'cycle_day');
      if (m.memoryKey === 'pregnancy_status' && !contextual.pregnancyStatus) contextual.pregnancyStatus = memFeature(m, 'pregnancy_status');
    }

    const observation: NaqaaScanObservationV1 = {
      schemaVersion: 1, occurredAt, scannerVersion: SCANNER_VERSION,
      color, physical, texture, spatial, contextual,
      quality: { rating, usable: rating === 'usable', ...(Array.isArray(qualityObj.reasons) ? { reasons: (qualityObj.reasons as string[]) } : {}) },
      provenance: { scanSource: 'vision', modelInfo: { provider: vision.provider, model: vision.model } },
    };

    // Scanner-level sufficiency (NOT fiqh): a usable observation + a cycle-day anchor.
    const missingInformation: NaqaaScannerResultV1['missingInformation'] = [];
    if (!contextual.cycleDay) {
      missingInformation.push({ key: 'cycle_day', reason: 'required_to_contextualize_the_scan', importance: 'required' });
    }
    const sufficient = missingInformation.length === 0;
    const result: NaqaaScannerResultV1 = {
      status: sufficient ? 'completed' : 'needs_information',
      observation,
      sufficiency: sufficient ? 'sufficient' : 'insufficient',
      missingInformation,
      questionNeeded: missingInformation.length > 0,
      ...(missingInformation.length > 0
        ? { question: { key: 'cycle_day', question: 'في أي يوم من الدورة تم هذا الفحص؟', reason: 'required_for_scanner_context' } }
        : {}),
      scannerVersion: SCANNER_VERSION,
      modelInfo: { provider: vision.provider, model: vision.model },
      observability: { runId, visionCalls: 1, memoryItemsUsed: memory.length },
    };
    return result;
  },
};
