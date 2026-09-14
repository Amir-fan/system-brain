/**
 * @kip
 * @module knowledge
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-005
 * @purpose Grounded knowledge answers: contract, sufficiency gate, citation integrity.
 *
 * The answer model NEVER sees project knowledge: it sees a bounded evidence pack
 * built from K15 retrieval, and it must answer only from that. Everything in this
 * module is deterministic and testable — the gate decides status BEFORE prose is
 * generated, and citation labels are validated after generation so a fabricated
 * [E99] can never reach a caller.
 */

export type AnswerStatus = 'answered' | 'insufficient_evidence' | 'conflicting_evidence' | 'needs_clarification';
export type AnswerConfidence = 'high' | 'medium' | 'low';
export type AnswerLanguage = 'ar' | 'en';

/** Bounded evidence pack: never the whole knowledge base, never 30 blind chunks. */
export const ANSWER_EVIDENCE_LIMITS = {
  maxItems: 6,
  minItems: 1,
  maxChars: 12_000,
  excerptChars: 700,
};

/**
 * Sufficiency thresholds. `semanticFloor` is a MEASURED starting point from the
 * K15 frozen gold set (answerable minimum top-cosine 0.6218 vs a not-present
 * 0.4607), NOT a universal truth — re-calibrate as the corpus grows.
 */
export const ANSWER_SUFFICIENCY = {
  semanticFloor: 0.62,
  semanticStrong: 0.7,
  agreementStrong: 0.5,
  /** Very short questions that already span many documents are ambiguous. */
  ambiguityMaxTokens: 2,
  ambiguityMinDocuments: 3,
  lexicalSupportMin: 0.3,
} as const;

export interface EvidenceReference {
  /** Local citation label the model must use: E1, E2, ... */
  label: string;
  sourceId: string;
  documentId: string;
  chunkId: string;
  sourceTitle?: string;
  documentTitle?: string;
  logicalPath?: string;
  headingContext?: string;
  excerpt: string;
  fusedScore: number;
  semanticScore?: number;
  lexicalScore?: number;
  foundBy: string[];
}

export interface RetrievalSummary {
  resultCount: number;
  semanticCandidates: number;
  lexicalCandidates: number;
  topSemanticScore: number | null;
  topLexicalScore: number | null;
  agreement: number;
  modelId: string;
}

/** Safe, explainable gate inputs — no hidden reasoning, no chain-of-thought. */
export interface ReasoningSignals {
  gate: 'proceeded' | 'insufficient' | 'ambiguous';
  semanticFloor: number;
  topSemanticScore: number | null;
  lexicalSupport: boolean;
  distinctDocuments: number;
  distinctSources: number;
  agreement: number;
  questionTokens: number;
  evidenceChars: number;
}

export interface KnowledgeAnswerInput {
  projectId: string;
  question: string;
  language?: AnswerLanguage;
  topK?: number;
  filters?: { sourceIds?: string[]; documentIds?: string[] };
}

export interface KnowledgeAnswerResult {
  status: AnswerStatus;
  answer?: string;
  /** Present for non-answered states: a short, safe, user-facing explanation. */
  message?: string;
  /** Present for needs_clarification: one short question (plus choices when useful). */
  clarification?: { question: string; choices?: string[] };
  confidence: AnswerConfidence;
  evidence: EvidenceReference[];
  retrievalSummary: RetrievalSummary;
  reasoningSignals: ReasoningSignals;
  model?: string;
  timings?: { retrievalMs: number; answerMs: number; totalMs: number };
}

export type KnowledgeAnswerErrorCode =
  | 'ANSWER_QUESTION_EMPTY'
  | 'ANSWER_ASSIGNMENT_MISSING'
  | 'ANSWER_PROVIDER_FAILED'
  | 'ANSWER_INVALID_MODEL_OUTPUT'
  | 'ANSWER_RETRIEVAL_UNAVAILABLE';

export const ANSWER_ERROR_MESSAGES: Record<KnowledgeAnswerErrorCode, string> = {
  ANSWER_QUESTION_EMPTY: 'اكتب سؤالًا أولًا.',
  ANSWER_ASSIGNMENT_MISSING: 'لا يوجد نموذج إجابة معيّن.',
  ANSWER_PROVIDER_FAILED: 'تعذر توليد الإجابة من مزوّد النموذج.',
  ANSWER_INVALID_MODEL_OUTPUT: 'تعذر التحقق من الإجابة المولّدة.',
  ANSWER_RETRIEVAL_UNAVAILABLE: 'تعذر البحث في المعرفة.',
};

export class KnowledgeAnswerFailure extends Error {
  readonly code: KnowledgeAnswerErrorCode;
  constructor(code: KnowledgeAnswerErrorCode, detail?: string) {
    super(ANSWER_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'KnowledgeAnswerFailure';
    if (detail) this.stack = `${this.stack ?? ''}\n[cause] ${detail}`;
  }
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

/**
 * Decide whether KIP may answer, BEFORE any prose is generated.
 * Deterministic and testable: same inputs, same decision.
 */
export function assessSufficiency(
  summary: RetrievalSummary,
  evidence: Array<{ documentId: string; sourceId: string; excerpt: string }>,
  question: string,
): { decision: 'proceed' | 'insufficient' | 'clarify'; confidence: AnswerConfidence; signals: ReasoningSignals } {
  const topSemantic = summary.topSemanticScore;
  const documents = new Set(evidence.map((e) => e.documentId));
  const sources = new Set(evidence.map((e) => e.sourceId));
  const questionTokens = tokenize(question);
  const lexicalSupport = (summary.topLexicalScore ?? 0) >= ANSWER_SUFFICIENCY.lexicalSupportMin;

  const signals: ReasoningSignals = {
    gate: 'proceeded',
    semanticFloor: ANSWER_SUFFICIENCY.semanticFloor,
    topSemanticScore: topSemantic,
    lexicalSupport,
    distinctDocuments: documents.size,
    distinctSources: sources.size,
    agreement: summary.agreement,
    questionTokens: questionTokens.length,
    evidenceChars: evidence.reduce((sum, e) => sum + e.excerpt.length, 0),
  };

  // 1. Nothing retrieved at all, or no semantic signal to stand on.
  if (evidence.length < ANSWER_EVIDENCE_LIMITS.minItems || topSemantic === null) {
    return { decision: 'insufficient', confidence: 'low', signals: { ...signals, gate: 'insufficient' } };
  }
  // 2. Measured cosine floor: below the weakest ANSWERABLE question we observed,
  //    the honest answer is that the knowledge does not cover this.
  if (topSemantic < ANSWER_SUFFICIENCY.semanticFloor) {
    return { decision: 'insufficient', confidence: 'low', signals: { ...signals, gate: 'insufficient' } };
  }
  // 3. Materially ambiguous: a bare 1-2 word question already matching many
  //    different documents has no single interpretation to answer.
  if (
    questionTokens.length <= ANSWER_SUFFICIENCY.ambiguityMaxTokens &&
    documents.size >= ANSWER_SUFFICIENCY.ambiguityMinDocuments
  ) {
    return { decision: 'clarify', confidence: 'low', signals: { ...signals, gate: 'ambiguous' } };
  }

  const strong =
    topSemantic >= ANSWER_SUFFICIENCY.semanticStrong &&
    summary.agreement >= ANSWER_SUFFICIENCY.agreementStrong &&
    documents.size >= 2;
  return { decision: 'proceed', confidence: strong ? 'high' : 'medium', signals };
}

export interface ParsedModelAnswer {
  status: AnswerStatus;
  answer?: string;
  /** Model-reported confidence, validated against the allowed vocabulary. */
  confidence?: AnswerConfidence;
  message?: string;
  clarification?: { question: string; choices?: string[] };
  citations: string[];
  /** Labels the model invented or misused, removed before anything is returned. */
  rejectedCitations: string[];
}

const STATUSES: AnswerStatus[] = ['answered', 'insufficient_evidence', 'conflicting_evidence', 'needs_clarification'];
const LABEL = /^E([1-9][0-9]*)$/;

/** Tolerant JSON extraction: models sometimes wrap JSON in prose or fences. */
function extractJson(raw: string): unknown | null {
  const cleaned = raw.replace(/```json/gi, '```').trim();
  const fenced = /```([\s\S]*?)```/.exec(cleaned);
  const candidates = [fenced?.[1], cleaned];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

/**
 * Validate structured model output. Citation integrity is enforced HERE: any label
 * that is not one of the supplied evidence labels is dropped and reported, and an
 * "answered" status without citations is rejected instead of being returned.
 */
export function parseModelAnswer(
  raw: string,
  evidenceLabels: string[],
): { ok: true; value: ParsedModelAnswer } | { ok: false; reason: string } {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not_json' };
  const obj = parsed as Record<string, unknown>;

  const status = typeof obj.status === 'string' ? (obj.status as AnswerStatus) : undefined;
  if (!status || !STATUSES.includes(status)) return { ok: false, reason: 'bad_status' };

  const allowed = new Set(evidenceLabels);
  const rawCitations = Array.isArray(obj.citations) ? obj.citations : [];
  const citations: string[] = [];
  const rejected: string[] = [];
  for (const entry of rawCitations) {
    if (typeof entry !== 'string') continue;
    const label = entry.trim().toUpperCase();
    if (LABEL.test(label) && allowed.has(label)) {
      if (!citations.includes(label)) citations.push(label);
    } else {
      rejected.push(label);
    }
  }

  const answer = typeof obj.answer === 'string' ? obj.answer.trim() : undefined;
  const message = typeof obj.message === 'string' ? obj.message.trim() : undefined;
  const confidence =
    obj.confidence === 'high' || obj.confidence === 'medium' || obj.confidence === 'low'
      ? (obj.confidence as AnswerConfidence)
      : undefined;

  if (status === 'answered') {
    // A factual answer with no valid citation is not traceable: refuse it.
    if (!answer) return { ok: false, reason: 'empty_answer' };
    if (citations.length === 0) return { ok: false, reason: 'no_valid_citations' };
  }

  let clarification: { question: string; choices?: string[] } | undefined;
  if (status === 'needs_clarification') {
    const q = typeof obj.clarification === 'string'
      ? obj.clarification
      : (obj.clarification && typeof obj.clarification === 'object'
          ? String((obj.clarification as { question?: unknown }).question ?? '')
          : '');
    if (!q.trim()) return { ok: false, reason: 'missing_clarification' };
    const rawChoices = obj.choices;
    const choices = Array.isArray(rawChoices)
      ? rawChoices.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).slice(0, 4)
      : undefined;
    clarification = { question: q.trim(), ...(choices && choices.length > 0 ? { choices } : {}) };
  }

  return {
    ok: true,
    value: {
      status,
      ...(answer ? { answer } : {}),
      ...(confidence ? { confidence } : {}),
      ...(message ? { message } : {}),
      ...(clarification ? { clarification } : {}),
      citations,
      rejectedCitations: rejected,
    },
  };
}

/** Deterministic post-check: the shape of an answer must match its status. */
export function verifyGroundedShape(value: Pick<ParsedModelAnswer, "status" | "answer" | "citations" | "clarification">): { ok: boolean; reason?: string } {
  if (value.status === 'answered') {
    if (!value.answer) return { ok: false, reason: 'answered_without_answer' };
    if (value.citations.length === 0) return { ok: false, reason: 'answered_without_citations' };
  }
  if (value.status === 'needs_clarification' && !value.clarification?.question) {
    return { ok: false, reason: 'clarification_missing' };
  }
  if (value.status === 'insufficient_evidence' && value.citations.length > 0) {
    return { ok: false, reason: 'insufficient_cited' };
  }
  return { ok: true };
}

/** Conservative language inference: script-based, never a model call. */
export function inferLanguage(question: string, requested?: AnswerLanguage): AnswerLanguage {
  if (requested) return requested;
  const arabic = (question.match(/[\u0600-\u06FF]/g) ?? []).length;
  const latin = (question.match(/[A-Za-z]/g) ?? []).length;
  return arabic >= latin ? 'ar' : 'en';
}
