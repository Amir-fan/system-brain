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
}

export interface SkillDefinition {
  id: string;
  version: number;
  description: string;
  requirements: SkillRequirements;
  validateInput(input: unknown): ValidationOutcome;
  validateOutput(output: unknown): ValidationOutcome;
  execute(ctx: SkillExecutionContext): Promise<unknown>;
}

export type SkillExecutionStatus = 'completed' | 'needs_clarification' | 'failed';

export interface SkillExecutionResult {
  status: SkillExecutionStatus;
  skillId: string;
  skillVersion: number;
  runId?: string;
  output?: unknown;
  clarification?: { reason: string; question: string; candidates?: string[] };
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
