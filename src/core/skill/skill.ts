/**
 * @kip
 * @module skill
 * @layer core
 * @owner intelligence-knowledge
 * @feature K20
 * @purpose Skills Runtime V1 contracts: Skill is an executable contract (not a
 *          prompt); the runtime validates, resolves, authorizes and executes it
 *          through KIP's existing Runtime/Run/Capability spine.
 *
 * Boundaries: SKILL = a bounded named capability. SKILLS RUNTIME = the execution
 * framework. LEARNING = a future improvement loop (not this module). NAQAA = future
 * domain composition built ON TOP.
 */

import type { UnderstandingResult } from '../understanding/understanding.ts';
import type { MemoryReference } from '../understanding/understanding.ts';
import type { ModelContentPart, ModelUsage } from '../model-gateway/model-gateway.ts';
import type { DecisionRequirement, ReadinessResult } from '../readiness/readiness.ts';

export interface SkillRequirements {
  understanding: boolean;
  memory: boolean;
  knowledge: boolean;
  model: boolean;
}

export type ValidationOutcome = { ok: true } | { ok: false; message: string };

/**
 * Narrow, provider-neutral model capability handed to a Skill that declares
 * `model: true`. It goes through the existing Model Gateway + Model Assignment
 * (the Skill never sees a provider adapter, API key, DB or gateway object).
 */
export interface SkillModelCapability {
  generateText(input: {
    workload: string;
    parts?: ModelContentPart[];
    message?: string;
    maxOutputTokens?: number;
    /** Optional provider-neutral structured-output contract (P0.4). */
    responseFormat?: { name: string; strict?: boolean; schema: Record<string, unknown> };
    /**
     * Optional per-call reasoning hint (provider-neutral vocabulary: 'low' | 'medium' | 'high' | 'off').
     * Wired in P0.4/K29-RADICAL so a workload can opt out of hidden reasoning that would
     * otherwise burn the output budget on a small terminal envelope. Provider-neutral;
     * the gateway maps it to the provider's own reasoning mechanism.
     */
    reasoning?: 'low' | 'medium' | 'high' | 'off';
  }): Promise<{
    text: string;
    provider?: string;
    model?: string;
    usage?: ModelUsage;
  }>;
}

/**
 * One retrieved knowledge passage handed to a Skill. Provenance is complete enough
 * for later citation validation (project-scoped source, document, chunk identity).
 */
export interface SkillKnowledgePassage {
  chunkId: string;
  documentId: string;
  sourceId: string;
  sourceTitle: string;
  chunkIndex: number;
  text: string;
  logicalPath?: string;
  headingContext?: string;
  /** Ranking signal already produced by the existing retriever (never a new score). */
  score?: number;
}

/**
 * Project-scoped Knowledge capability for Skills that declare `knowledge: true`.
 * The runtime BINDS the project id, so a Skill can only search its own project's
 * knowledge — it can never widen or cross the project boundary. The Skill chooses
 * queries and (optionally) which already-approved sources to search.
 */
export interface SkillKnowledgeCapability {
  search(input: { query: string; topK?: number; sourceIds?: string[] }): Promise<SkillKnowledgePassage[]>;
  /** Resolve source titles to this project's source ids (empty when not found). */
  resolveSources(titles: string[]): Promise<Array<{ id: string; title: string }>>;
  /** Bounded adjacent context of a passage (same document, ±window chunks). */
  adjacent(chunkId: string, window?: number): Promise<SkillKnowledgePassage[]>;
  /**
   * B3a: bounded reload of ALREADY-SELECTED approved chunks by id (project-scoped).
   * Not semantic retrieval: no query, no embedding, no search. Optional.
   */
  loadByIds?(chunkIds: string[]): Promise<SkillKnowledgePassage[]>;
}

/**
 * Bounded, non-reasoning structured trace a Skill may attach for admin inspection.
 * NEVER chain-of-thought, prompts, or raw model output: only auditable references.
 */
/**
 * B3a: bounded, non-authoritative reusable turn context a Skill may hand back so a later
 * turn that merely answers the stored pending need can continue from the SAME derived
 * issue/requirements/evidence instead of re-planning, re-retrieving and re-interpreting.
 * Identity + derived references only: no source text, no prompts, no CoT, no ruling.
 */
export interface SkillTurnContext {
  skillId: string;
  skillVersion: number;
  /** Bounded digest of the planned issue (never the issue text itself). */
  issueSignature: string;
  /** The already-derived material requirements (existing K22 type, reused verbatim). */
  requirements: DecisionRequirement[];
  /** Approved evidence refs already selected for this case. */
  evidenceRefs: string[];
  /** Approved source ids those refs belong to (identity, re-validated per turn). */
  sourceIds: string[];
  /** Case signature of the state that produced the current pending need. */
  baseCaseSignature: string;
  at: string;
}
export const MAX_SKILL_CONTEXT_REQUIREMENTS = 8;
export const MAX_SKILL_CONTEXT_EVIDENCE = 10;
export const MAX_SKILL_CONTEXT_SOURCES = 6;

/** Per-model-call timing metadata measured by the Skill runtime (never by the Skill). Safe fields only. */
export interface SkillModelCallTiming {
  call_index: number;
  duration_ms: number;
  status: 'success' | 'error' | 'timeout';
  timeout: boolean;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  /** Provider backend that served the call, when reported. */
  served_by?: string;
  /** Hidden reasoning tokens, when the provider reports them separately. */
  reasoning_tokens?: number;
  /** Why generation stopped (stop / length ...), when reported. */
  finish_reason?: string;
}

/** Per-Knowledge-operation timing metadata measured by the Skill runtime. */
export interface SkillKnowledgeCallTiming {
  operation: string;
  duration_ms: number;
  status: 'success' | 'error';
}

/**
 * Generic per-run stage timings (Core/platform boundary, skill-agnostic).
 * Present on successful results and emitted to the server log for failed runs so
 * performance evidence is not lost when a turn fails.
 */
export interface SkillTraceTimings {
  total_ms: number;
  context_ms: number;
  skill_ms: number;
  persistence_ms: number;
  model_total_ms: number;
  model_call_count: number;
  model_calls: SkillModelCallTiming[];
  knowledge_total_ms: number;
  knowledge_call_count: number;
  knowledge_calls: SkillKnowledgeCallTiming[];
}

/** Generic execution-trace vocabulary (domain-neutral; works for any Skill). */
export type ExecutionStageStatus = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'SKIPPED';
export type ExecutionStageName =
  | 'REQUEST'
  | 'CONTEXT'
  | 'MODEL_CALL'
  | 'KNOWLEDGE_SEARCH'
  | 'OUTPUT_PARSE'
  | 'CITATION_VALIDATION'
  | 'PERSISTENCE'
  | 'RESPONSE';

/** One observable stage of a run. Safe fields only: durations, counts, codes — never prompts
 *  or model reasoning. */
export interface SkillExecutionStage {
  stage: ExecutionStageName;
  /** 1-based index for repeated stages (MODEL_CALL / KNOWLEDGE_SEARCH). */
  index?: number;
  status: ExecutionStageStatus;
  duration_ms?: number;
  /** Short, safe technical facts (provider, model, tokens, operation, error code…). */
  detail?: Record<string, string | number | boolean>;
}

export type ExecutionOutcome = 'COMPLETED' | 'TECHNICAL_FAILURE' | 'INSUFFICIENT_EVIDENCE' | 'ASK_USER';

/** Generic per-run execution trace, measured by the runtime (never by a Skill). */
export interface SkillExecutionTrace {
  outcome: ExecutionOutcome;
  stages: SkillExecutionStage[];
  failureStage?: ExecutionStageName;
  failureCode?: string;
  slowest?: { stage: ExecutionStageName; index?: number; duration_ms: number };
  totals?: { total_ms: number; model_ms: number; knowledge_ms: number; core_ms: number; persistence_ms: number };
}

export interface SkillTraceSummary {
  issue?: string;
  status?: string;
  /** Generic execution trace (see SkillExecutionTrace) — observability only. */
  execution?: SkillExecutionTrace;
  /** Measured by the runtime at the capability boundary (overwritten, never skill-supplied). */
  timings?: SkillTraceTimings;
  approvedSourceIds?: string[];
  evidence?: Array<{ chunkId: string; sourceId: string; note?: string }>;
  requirementKeys?: string[];
  notes?: string[];
  /** Result of the skill's own decision step (domain-neutral). */
  decisionStatus?: string;
  decisionLabel?: string;
  confidence?: string;
  sourceSupport?: string;
  retrievedEvidenceIds?: string[];
  acceptedEvidenceRefs?: string[];
  gapKeys?: string[];
  /** Model Gateway workload + provider/model actually used (never a prompt). */
  workload?: string;
  /** B3a: which expensive stages actually ran this turn (bounded booleans). */
  plannerCalled?: boolean;
  retrievalCalled?: boolean;
  interpreterCalled?: boolean;
  decisionCalled?: boolean;
  /** True when approved evidence was re-read by id (not semantic search). */
  evidenceReloadCalled?: boolean;
  model?: string;
}

/**
 * A skill may return a user-facing answer (domain-neutral). The conversation renders
 * it instead of a generic placeholder. It carries no internal keys and no reasoning.
 */
export interface SkillAnswer {
  text: string;
  sourceTitle?: string;
  /** Bounded evidence references the answer was grounded in. */
  evidenceIds?: string[];
  /** Short label for the answer category when a skill has one (e.g. a ruling label). */
  label?: string;
}

export interface SkillExecutionContext {
  projectId: string;
  actor: string;
  /** The validated Skill input payload. */
  input?: unknown;
  /** Structured Understanding (present when requirements.understanding). */
  understanding?: UnderstandingResult;
  /** Bounded relevant memory (present when requirements.memory). */
  memory?: MemoryReference[];
  /** Narrow Model Gateway capability (present when requirements.model). */
  model?: SkillModelCapability;
  /** Project-scoped Knowledge retrieval (present when requirements.knowledge). */
  knowledge?: SkillKnowledgeCapability;
  /** Decision Readiness result (present when the skill declares readiness requirements). */
  readiness?: ReadinessResult;
}

export interface SkillDefinition {
  id: string;
  version: number;
  description: string;
  requirements: SkillRequirements;
  /**
   * Optional K22 Decision Readiness gate. When declared, the Skills Runtime evaluates
   * readiness BEFORE the skill body runs and blocks execution unless READY_FOR_DECISION.
   * The DOMAIN supplies the material requirements; the gate stays project-agnostic.
   */
  readiness?: { requirements: DecisionRequirement[] };
  validateInput(input: unknown): ValidationOutcome;
  validateOutput(output: unknown): ValidationOutcome;
  execute(ctx: SkillExecutionContext): Promise<unknown>;
}

export type SkillExecutionStatus = 'completed' | 'needs_clarification' | 'needs_information' | 'failed';

export interface SkillExecutionResult {
  status: SkillExecutionStatus;
  skillId: string;
  skillVersion: number;
  runId?: string;
  output?: unknown;
  clarification?: { reason: string; question: string; candidates?: string[] };
  /** Present when readiness was evaluated (K22). */
  readiness?: ReadinessResult;
  /** Present when the skill attached a bounded, non-reasoning admin trace. */
  trace?: SkillTraceSummary;
  /** Present when the skill produced a user-facing answer (domain-neutral). */
  answer?: SkillAnswer;
  /**
   * Bounded case facts the skill BOUND from this turn's statement/evidence to its own
   * declared need vocabulary. The conversation stores them in the SAME case store with
   * provenance; Core never interprets them.
   */
  caseFacts?: Record<string, unknown>;
  /** B3a: refreshed bounded reusable turn context (bounded, replaced each turn). */
  skillContext?: SkillTurnContext;
  error?: { message: string; code?: string };
}

export type SkillErrorCode =
  | 'SKILL_NOT_FOUND'
  | 'SKILL_INVALID_INPUT'
  | 'SKILL_INVALID_OUTPUT'
  | 'SKILL_AMBIGUITY';

export const SKILL_ERROR_MESSAGES: Record<SkillErrorCode, string> = {
  SKILL_NOT_FOUND: 'المهارة غير موجودة.',
  SKILL_INVALID_INPUT: 'مدخلات المهارة غير صالحة.',
  SKILL_INVALID_OUTPUT: 'مخرجات المهارة غير صالحة.',
  SKILL_AMBIGUITY: 'المدخل غير واضح بما يكفي للمتابعة.',
};

export class SkillFailure extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, detail?: string) {
    super(SKILL_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'SkillFailure';
    if (detail) this.stack = `${this.stack ?? ''}\n[cause] ${detail}`;
  }
}
