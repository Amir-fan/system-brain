/**
 * @kip
 * @module memory
 * @layer core
 * @owner intelligence-knowledge
 * @feature K18
 * @purpose Generic project-scoped Memory: REMEMBER / RECALL / SUPERSEDE / ARCHIVE / RELEVANT.
 *
 * Memory stores durable contextual information scoped to a project. It knows nothing
 * about any client domain — scope/type/key are generic labels and payload is an opaque
 * JSONB document the engine never interprets. Domain layers (e.g. Naqaa skills) build
 * their own semantics ON TOP of this foundation; they are never hard-coded here.
 *
 * Memory is NOT knowledge storage, conversation-history storage, an understanding
 * engine, a skills runtime, a learning dataset, or any analytics/marketing engine.
 */

export const MEMORY_SCOPES = ['user', 'conversation', 'case'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SOURCES = ['user', 'application', 'conversation', 'skill', 'system'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const ACTIVE = 'active' as const;
export const SUPERSEDED = 'superseded' as const;
export const ARCHIVED = 'archived' as const;

/** Bounded-context defaults. retrieveRelevant NEVER dumps memory by default. */
export const DEFAULT_RELEVANT_LIMIT = 8;
export const MAX_RELEVANT_LIMIT = 20;

export interface MemoryProvenance {
  source: MemorySource;
  /** Optional free-form detail (e.g. which skill/application wrote it). */
  detail?: string;
}

export interface MemoryRecord {
  id: string;
  projectId: string;
  scope: MemoryScope;
  subjectId: string;
  memoryType: string;
  memoryKey: string;
  payload: Record<string, unknown>;
  status: MemoryStatus;
  provenance: MemoryProvenance;
  validFrom?: string;
  supersededById?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RememberInput {
  projectId: string;
  scope: MemoryScope;
  subjectId: string;
  memoryType: string;
  memoryKey: string;
  payload: Record<string, unknown>;
  provenance?: Partial<MemoryProvenance>;
  validFrom?: string;
}

export interface RecallInput {
  projectId: string;
  scope?: MemoryScope;
  subjectId?: string;
  memoryType?: string;
  memoryKey?: string;
}

export interface SupersedeInput extends Omit<RememberInput, 'provenance' | 'validFrom'> {
  provenance?: Partial<MemoryProvenance>;
  validFrom?: string;
}

export interface ArchiveInput {
  projectId: string;
  memoryId: string;
}

export interface RelevantMemoryQuery {
  projectId: string;
  /** Optional free-text terms; matched against memory_key + payload text deterministically. */
  context?: string;
  scope?: MemoryScope;
  subjectId?: string;
  memoryType?: string;
  limit?: number;
}

export type MemoryErrorCode = 'MEMORY_SCOPE_INVALID' | 'MEMORY_STATUS_INVALID' | 'MEMORY_CONTRACT_INVALID';

export const MEMORY_ERROR_MESSAGES: Record<MemoryErrorCode, string> = {
  MEMORY_SCOPE_INVALID: 'نطاق الذاكرة غير صالح.',
  MEMORY_STATUS_INVALID: 'حالة الذاكرة غير صالحة.',
  MEMORY_CONTRACT_INVALID: 'سجل الذاكرة غير صالح.',
};

export class MemoryFailure extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, detail?: string) {
    super(MEMORY_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'MemoryFailure';
    if (detail) this.stack = `${this.stack ?? ''}\n[cause] ${detail}`;
  }
}

export function isMemoryScope(v: unknown): v is MemoryScope {
  return typeof v === 'string' && (MEMORY_SCOPES as readonly string[]).includes(v);
}
export function isMemoryStatus(v: unknown): v is MemoryStatus {
  return typeof v === 'string' && (MEMORY_STATUSES as readonly string[]).includes(v);
}
export function isMemorySource(v: unknown): v is MemorySource {
  return typeof v === 'string' && (MEMORY_SOURCES as readonly string[]).includes(v);
}
