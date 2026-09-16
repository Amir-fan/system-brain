/**
 * @kip
 * @module readiness
 * @layer core
 * @owner platform-core
 * @feature K22
 * @purpose Generic Decision Readiness gate: a small, project-agnostic boundary that
 *          prevents a decision-capable skill from proceeding until the materially
 *          necessary context is complete.
 *
 * Project-agnostic: Core knows nothing about any domain (no hayd/istihada/nifas/
 * pregnancy/cycle/purity/prayer/fasting). The DOMAIN skill supplies the material
 * requirements; the generic gate evaluates completeness against known context.
 *
 * Separation preserved:
 *   Understanding (K19) = do we understand what the user means?
 *   Readiness (K22)     = do we have enough materially relevant information to allow
 *                         the requested decision process to proceed?
 *
 * This is NOT the Fiqh decision engine and NOT a question-planning engine.
 */

export type ReadinessStatus = 'READY_FOR_DECISION' | 'NEEDS_INFORMATION' | 'INSUFFICIENT_CONTEXT';

/** A deterministic, user-facing question for one missing material requirement. */
export interface QuestionSpec {
  /** Same semantics as the requirement key — wording never changes the requirement. */
  key: string;
  /** Simple, short, non-technical, non-jurisprudential wording (~12-year-old readable). */
  wording: string;
}

/**
 * A requirement declared by the requesting/domain skill. `material = true` means its
 * absence can change/prevent a valid decision. Non-material requirements never block.
 */
export interface DecisionRequirement {
  key: string;
  description: string;
  material: boolean;
  /**
   * When present, a missing material requirement can be resolved by asking the user
   * (NEEDS_INFORMATION). When absent, the gap cannot be asked away — it depends on a
   * context provider that is unavailable (INSUFFICIENT_CONTEXT).
   */
  question?: QuestionSpec;
  /**
   * Optional structured-interaction hint (K23). The conversation layer renders the
   * missing requirement as a client-appropriate interaction of this type. Additive and
   * optional — the readiness gate itself never reads it.
   */
  interaction?: { type: string; options?: string[]; allowOther?: boolean };
}

export interface KnownContextItem {
  key: string;
  value: unknown;
  source: 'memory' | 'user' | 'conversation' | 'case';
}

export interface MissingMaterialInformation {
  key: string;
  description: string;
  question?: QuestionSpec;
  /**
   * The requirement's OWN structured-interaction hint (K23), carried through so a
   * caller can render the question's control without a separate static lookup.
   * Additive and optional — the gate itself never reads it.
   */
  interaction?: { type: string; options?: string[]; allowOther?: boolean };
}

export interface ReadinessResult {
  status: ReadinessStatus;
  satisfied: string[];
  missing: MissingMaterialInformation[];
  /** The single next question (one information need), when one is needed. */
  nextQuestion?: QuestionSpec;
  knownContextUsed: number;
}

export const READINESS_ERROR_MESSAGES = {
  READY_FOR_DECISION: 'السياق مكتمل ويمكن المتابعة.',
  NEEDS_INFORMATION: 'نحتاج معلومة إضافية قبل المتابعة.',
  INSUFFICIENT_CONTEXT: 'لا يمكن إكمال السياق المطلوب حالياً.',
} as const;

/** A known value counts as satisfying a requirement only if it is present (not null/undefined). */
export function hasKnownValue(item: KnownContextItem | undefined): boolean {
  return !!item && item.value !== null && item.value !== undefined && item.value !== '';
}
