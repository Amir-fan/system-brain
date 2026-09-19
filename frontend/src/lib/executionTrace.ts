/**
 * Execution-trace presentation helpers for the Skill Tester (K28).
 *
 * Plain, dependency-free formatting so the internal tester can render a generic execution
 * trace for ANY Skill: stage/status/outcome labels, a measured bottleneck, and HUMAN-READABLE
 * evidence labels (source title when the payload carries one, otherwise «مقطع N» — never a raw
 * UUID in the normal view). No prompts, no model reasoning, no ids are computed here.
 */

export type TraceStageStatus = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';
export type TraceStageName =
  | 'REQUEST'
  | 'CONTEXT'
  | 'MODEL_CALL'
  | 'KNOWLEDGE_SEARCH'
  | 'OUTPUT_PARSE'
  | 'CITATION_VALIDATION'
  | 'PERSISTENCE'
  | 'RESPONSE';

export interface TraceStage {
  stage: TraceStageName;
  index?: number;
  status: TraceStageStatus;
  duration_ms?: number;
  detail?: Record<string, string | number | boolean>;
}

export interface ExecutionTrace {
  outcome: 'COMPLETED' | 'TECHNICAL_FAILURE' | 'INSUFFICIENT_EVIDENCE' | 'ASK_USER';
  stages: TraceStage[];
  failureStage?: TraceStageName;
  failureCode?: string;
  slowest?: { stage: TraceStageName; index?: number; duration_ms: number };
  totals?: { total_ms: number; model_ms: number; knowledge_ms: number; core_ms: number; persistence_ms: number };
}

const STAGE_LABELS: Record<TraceStageName, string> = {
  REQUEST: 'استلام الطلب',
  CONTEXT: 'تحميل السياق',
  MODEL_CALL: 'استدعاء الموديل',
  KNOWLEDGE_SEARCH: 'البحث في المصادر',
  OUTPUT_PARSE: 'تنسيق النتيجة',
  CITATION_VALIDATION: 'التحقق من المراجع',
  PERSISTENCE: 'حفظ الجلسة',
  RESPONSE: 'إعادة الرد',
};

const STATUS_LABELS: Record<TraceStageStatus, string> = {
  SUCCESS: 'نجح',
  FAILED: 'فشل',
  TIMEOUT: 'انتهت المهلة',
  SKIPPED: 'لم تُنفذ',
};

const OUTCOME_LABELS: Record<ExecutionTrace['outcome'], string> = {
  COMPLETED: 'مكتمل',
  TECHNICAL_FAILURE: 'فشل تقني',
  INSUFFICIENT_EVIDENCE: 'الدليل غير كافٍ',
  ASK_USER: 'سؤال للمستخدمة',
};

/** Only the codes the runtime can actually distinguish today. */
const CODE_NOTES: Record<string, string> = {
  INVALID_OUTPUT_ENVELOPE: 'أعاد الموديل نتيجة، لكن KIP لم يتمكن من تحويلها إلى صيغة جواب صالحة.',
  MODEL_TIMEOUT: 'انتهت المهلة المحددة لاستدعاء الموديل قبل أن يعود بالنتيجة.',
  MODEL_PROVIDER_ERROR: 'فشل تقني من مزوّد الموديل (شبكة/خدمة) قبل اكتمال الاستدعاء.',
  CITATION_VALIDATION_FAILED: 'المراجع التي ذكرها الموديل لم تكن من الأدلة المسترجعة.',
  KNOWLEDGE_SEARCH_FAILED: 'فشل تنفيذي أثناء البحث في المصادر المعتمدة.',
  NO_APPROVED_SOURCES: 'لا توجد مصادر معتمدة متاحة لهذا المشروع.',
  NO_APPROVED_EVIDENCE_RETRIEVED: 'البحث لم يُرجِع أي مقطع من المصادر المعتمدة.',
  TOOL_CALL_LIMIT: 'وصل التنفيذ إلى الحد الأقصى المسموح من الاستدعاءات.',
  PERSISTENCE_FAILED: 'لم تُحفظ حالة التشغيل كما ينبغي.',
  SKILL_INPUT_INVALID: 'مدخلات المهارة لم تطابق العقد المطلوب.',
  UNKNOWN_TECHNICAL_FAILURE: 'فشل تقني غير مصنّف في السجلات الحالية.',
};

export const stageLabel = (s: TraceStageName): string => STAGE_LABELS[s] ?? s;
export const statusLabel = (s: TraceStageStatus): string => STATUS_LABELS[s] ?? s;
export const outcomeLabel = (o: ExecutionTrace['outcome']): string => OUTCOME_LABELS[o] ?? o;
export const codeNote = (code?: string): string | undefined => (code ? CODE_NOTES[code] ?? 'فشل تقني مسجَّل في مسار التنفيذ.' : undefined);

/** «استدعاء الموديل #2» / «البحث في المصادر #1» */
export const stageTitle = (s: TraceStage): string => `${stageLabel(s.stage)}${s.index ? ` #${s.index}` : ''}`;

/** Seconds with one decimal, e.g. 8.4 ث */
export function formatDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'غير متاح';
  return `${(ms / 1000).toFixed(1)} ث`;
}

export function formatTokens(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toLocaleString('en-US')} توكن` : 'غير متاح';
}

export interface TraceSummary {
  outcomeLabel: string;
  totalLabel: string;
  slowestLabel?: string;
  failureLabel?: string;
  failureCode?: string;
  failureNote?: string;
  shares?: { model: number; knowledge: number; kip: number; persistence: number };
}

/** Deterministic summary computed ONLY from measured durations. */
export function summarizeExecution(execution: ExecutionTrace): TraceSummary {
  const t = execution.totals;
  const slowest = execution.slowest;
  const shares = t && t.total_ms > 0
    ? {
        model: Math.round((t.model_ms / t.total_ms) * 100),
        knowledge: Math.round((t.knowledge_ms / t.total_ms) * 100),
        kip: Math.round((t.core_ms / t.total_ms) * 100),
        persistence: Math.round((t.persistence_ms / t.total_ms) * 100),
      }
    : undefined;
  return {
    outcomeLabel: outcomeLabel(execution.outcome),
    totalLabel: formatDuration(t?.total_ms),
    ...(slowest ? { slowestLabel: `${stageLabel(slowest.stage)}${slowest.index ? ` #${slowest.index}` : ''} — ${formatDuration(slowest.duration_ms)}` } : {}),
    ...(execution.failureStage ? { failureLabel: stageLabel(execution.failureStage) } : {}),
    ...(execution.failureCode ? { failureCode: execution.failureCode, failureNote: codeNote(execution.failureCode) } : {}),
    ...(shares ? { shares } : {}),
  };
}

/**
 * Human-readable evidence labels for the normal tester view: the approved source title when the
 * payload carries one, otherwise «مقطع N» in stable order. The ids stay in the payload for
 * optional technical expansion — provenance is untouched.
 */
export function evidenceLabels(input: {
  sourceTitle?: string;
  evidenceIds?: string[];
  traceEvidence?: Array<{ chunkId: string }>;
  acceptedRefs?: string[];
}): string[] {
  const ids = input.evidenceIds?.length
    ? input.evidenceIds
    : input.acceptedRefs?.length
      ? input.acceptedRefs
      : (input.traceEvidence ?? []).map((e) => e.chunkId);
  const title = input.sourceTitle;
  if (title && ids.length > 0) return ids.map(() => title);
  return ids.map((_id, i) => `مقطع ${i + 1}`);
}
