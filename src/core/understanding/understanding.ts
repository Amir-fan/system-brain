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
