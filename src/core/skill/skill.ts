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
  generateText(input: { workload: string; parts?: ModelContentPart[]; message?: string }): Promise<{
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
}

/**
 * Bounded, non-reasoning structured trace a Skill may attach for admin inspection.
 * NEVER chain-of-thought, prompts, or raw model output: only auditable references.
 */
export interface SkillTraceSummary {
  issue?: string;
  status?: string;
  approvedSourceIds?: string[];
  evidence?: Array<{ chunkId: string; sourceId: string; note?: string }>;
  requirementKeys?: string[];
  notes?: string[];
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
