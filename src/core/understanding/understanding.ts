/**
 * @kip
 * @module understanding
 * @layer core
 * @owner intelligence-knowledge
 * @feature K19
 * @purpose Generic Understanding layer: interpret WHAT the current input means in the
 *          available bounded context, and whether enough context exists to continue.
 *
 * Understanding does NOT answer, decide domain facts, execute skills, train, or act
 * as an agent. It is deterministic-first (0 model calls in V1). It READS bounded
 * relevant memory; it NEVER writes durable memory (a correction is returned as a
 * structured interpretation — an explicit caller decides whether to supersede).
 *
 * Boundaries: Memory = what KIP remembers. Understanding = what KIP believes the
 * CURRENT INPUT means. Skills = what KIP knows how to do (not built). Knowledge =
 * available evidence. Learning = improvement over time (not built).
 */

import { normalizeDigits, normalizeIsoDate } from './numbers.ts';

export type UnderstandingStatus = 'CLEAR' | 'NEEDS_CLARIFICATION';

export type DialogueAct =
  | 'QUESTION'
  | 'STATEMENT'
  | 'CORRECTION'
  | 'CONFIRMATION'
  | 'REJECTION'
  | 'FOLLOW_UP'
  | 'COMMAND'
  | 'OTHER';

export type UnderstandingLanguage = 'ar' | 'en' | null;

export interface MemoryReference {
  id: string;
  scope: string;
  memoryType: string;
  memoryKey: string;
  payload: Record<string, unknown>;
}

export interface BoundedUnderstandingContext {
  user: MemoryReference[];
  conversation: MemoryReference[];
  case: MemoryReference[];
}

export interface UnderstandingInput {
  projectId: string;
  /** The current user input (required, non-empty). */
  text: string;
  subjectId?: string;
  conversationId?: string;
  caseId?: string;
  /** Explicit request timestamp (ISO) used for temporal normalization; never server-time. */
  requestTimestamp?: string;
  /** Pre-assembled bounded context (from the existing MemoryService). */
  context?: BoundedUnderstandingContext;
}

export interface UnderstandingCorrection {
  /** The memory key the correction targets (when resolvable from context). */
  target?: string;
  /** Multiple compatible facts prevent the correction from targeting any one of them. */
  targetAmbiguous?: true;
  /** Previous value (from active memory) when available. */
  old?: string;
  /** The new value extracted from the input. */
  new?: string;
}

export interface UnderstandingFact {
  key: string;
  value: string;
  /** Original expression in the input. */
  original: string;
}

export interface ReferenceResult {
  resolved: boolean;
  /** Resolved referent when resolvable from bounded context. */
  referent?: string;
  needsClarification?: boolean;
}

export interface Clarification {
  reason: string;
  question: string;
  candidates?: string[];
}

export interface AmbiguityResult {
  material: boolean;
  reason?: string;
}

export interface ContextUsage {
  userCount: number;
  conversationCount: number;
  caseCount: number;
  scopes: string[];
}

/** Categorical certainty only — never a percentage. */
export type FactCertainty = 'CERTAIN' | 'UNCERTAIN' | 'UNKNOWN';
/** Where a current case value came from. EVIDENCE is contract-compatibility only. */
export type FactProvenance = 'user_statement' | 'user_answer' | 'memory' | 'evidence';

type CorrectionValueKind = 'boolean' | 'date' | 'number' | 'time';

const TRUE_ANSWER = /^(?:true|yes|y|yeah|correct|نعم|أجل|اجل|صحيح|أي نعم|اي نعم|إي نعم)$/iu;
const FALSE_ANSWER = /^(?:false|no|n|لا|كلا|ليس)$/iu;

/** The same whole-answer vocabulary is used for interpretation and admission. */
export function normalizeBooleanAnswer(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/gu, ' ');
  if (TRUE_ANSWER.test(text)) return true;
  if (FALSE_ANSWER.test(text)) return false;
  return undefined;
}

/**
 * Corrections without a pending requirement may replace only a uniquely matching,
 * already-known scalar type. Free-form strings deliberately have no inferred type:
 * accepting them would let an ambiguous correction overwrite an arbitrary fact.
 */
export function normalizeCorrectionValue(value: unknown): boolean | number | string | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  const normalized = normalizeDigits(value).trim();
  const boolean = normalizeBooleanAnswer(normalized);
  if (boolean !== undefined) return boolean;

  const date = normalizeIsoDate(normalized);
  if (date) return date;

  if (/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(normalized)) return normalized.padStart(5, '0');
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) {
    const number = Number(normalized);
    return Number.isFinite(number) ? number : undefined;
  }
  return undefined;
}

function correctionValueKind(value: unknown): CorrectionValueKind | undefined {
  const normalized = normalizeCorrectionValue(value);
  if (typeof normalized === 'boolean') return 'boolean';
  if (typeof normalized === 'number') return 'number';
  if (typeof normalized === 'string') return normalized.includes(':') ? 'time' : 'date';
  return undefined;
}

export function correctionValuesCompatible(current: unknown, replacement: unknown): boolean {
  const currentKind = correctionValueKind(current);
  return currentKind !== undefined && currentKind === correctionValueKind(replacement);
}

/**
 * A bounded, GENERIC candidate fact extracted from the user's own words. It records WHAT
 * was said (duration, quantity, cessation, categorical, observation) plus its certainty
 * and provenance — never what it means in any domain. Binding to a domain need, and all
 * interpretation, belongs to the domain skill.
 */
export interface CandidateFact {
  kind: 'duration' | 'quantity' | 'boolean' | 'categorical' | 'observation';
  value: number | boolean | string;
  unit?: string;
  /** Verbatim user fragment (bounded) — kept for trace/debugging. */
  originalText: string;
  certainty: FactCertainty;
  provenance: FactProvenance;
}

export interface UnderstandingResult {
  status: UnderstandingStatus;
  language: UnderstandingLanguage;
  dialogueAct: DialogueAct;
  issues: string[];
  references: ReferenceResult;
  corrections: UnderstandingCorrection[];
  facts: UnderstandingFact[];
  /** Generic candidate facts from this message (domain-free; may be hedged/hypothetical). */
  candidates?: CandidateFact[];
  ambiguity: AmbiguityResult;
  clarification?: Clarification;
  contextUsed: ContextUsage;
}

export type UnderstandingErrorCode = 'UNDERSTANDING_TEXT_EMPTY';

export const UNDERSTANDING_ERROR_MESSAGES: Record<UnderstandingErrorCode, string> = {
  UNDERSTANDING_TEXT_EMPTY: 'النص مطلوب للفهم.',
};

export class UnderstandingFailure extends Error {
  readonly code: UnderstandingErrorCode;
  constructor(code: UnderstandingErrorCode, detail?: string) {
    super(UNDERSTANDING_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'UnderstandingFailure';
    if (detail) this.stack = `${this.stack ?? ''}\n[cause] ${detail}`;
  }
}
