/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-ingestion
 * @feature K0-011
 * @purpose Provider-neutral ingestion vocabulary (statuses, triggers, errors, shapes).
 *
 * Ingestion owns the PROCESSING lifecycle only; source identity belongs to the
 * Source Registry. Shared contract between the service, adapters, and persistence.
 */

export const INGESTION_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

export const INGESTION_TRIGGERS = ['manual', 'retry'] as const;
export type IngestionTrigger = (typeof INGESTION_TRIGGERS)[number];

export const INGESTION_ERROR_CODES = [
  'SOURCE_NOT_FOUND',
  'SOURCE_ARCHIVED',
  'RAW_ARTIFACT_MISSING',
  'UNSUPPORTED_SOURCE_TYPE',
  'ACQUISITION_FAILED',
  'NORMALIZATION_FAILED',
  'INGESTION_ALREADY_RUNNING',
  'INGESTION_NOT_FOUND',
  'INTERNAL_ERROR',
] as const;
export type IngestionErrorCode = (typeof INGESTION_ERROR_CODES)[number];

export interface IngestionJob {
  id: string;
  projectId: string;
  sourceId: string;
  status: IngestionStatus;
  attemptNumber: number;
  triggerType: IngestionTrigger;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorCode?: IngestionErrorCode;
  errorMessage?: string;
  createdBySubject: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIngestionJobInput {
  projectId: string;
  sourceId: string;
  attemptNumber: number;
  triggerType: IngestionTrigger;
  createdBySubject: string;
}

/** Normalized, derived output. Deliberately NOT the canonical Document model. */
export interface IngestionOutput {
  id: string;
  projectId: string;
  ingestionJobId: string;
  sourceId: string;
  contentType: 'text/plain';
  normalizedText: string;
  contentSha256: string;
  charCount: number;
  createdAt: string;
}

export interface SaveIngestionOutputInput {
  projectId: string;
  ingestionJobId: string;
  sourceId: string;
  normalizedText: string;
  contentSha256: string;
  charCount: number;
}

/** What an acquisition adapter hands back - provider-neutral. */
export interface AcquiredContent {
  sourceId: string;
  contentType: 'text/plain';
  /** Text extracted from the raw material; normalization happens afterwards. */
  text: string;
  /** Human-readable origin of the material (never source contents or secrets). */
  provenance: string;
}

/** Safe, user-facing wording for every failure code. */
const USER_MESSAGES: Record<IngestionErrorCode, string> = {
  SOURCE_NOT_FOUND: 'المصدر غير موجود.',
  SOURCE_ARCHIVED: 'المصدر مؤرشف ولا يمكن معالجته.',
  RAW_ARTIFACT_MISSING: 'لا يوجد محتوى أصلي محفوظ لهذا المصدر.',
  UNSUPPORTED_SOURCE_TYPE: 'نوع هذا المصدر غير مدعوم للمعالجة بعد.',
  ACQUISITION_FAILED: 'تعذر قراءة محتوى المصدر.',
  NORMALIZATION_FAILED: 'تعذر تجهيز محتوى المصدر.',
  INGESTION_ALREADY_RUNNING: 'توجد معالجة قيد التنفيذ لهذا المصدر.',
  INGESTION_NOT_FOUND: 'سجل المعالجة غير موجود.',
  INTERNAL_ERROR: 'حدث خطأ غير متوقع أثناء المعالجة.',
};

export const userMessage = (code: IngestionErrorCode): string => USER_MESSAGES[code];

/** Explicit, typed ingestion failure. Never carries raw content. */
export class IngestionFailure extends Error {
  readonly code: IngestionErrorCode;
  constructor(code: IngestionErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'IngestionFailure';
    this.code = code;
  }
}
