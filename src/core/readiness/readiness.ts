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

import { normalizeDigits, parseNumberLoose } from '../understanding/numbers.ts';

export type ReadinessStatus = 'READY_FOR_DECISION' | 'NEEDS_INFORMATION' | 'INSUFFICIENT_CONTEXT';

/**
 * The ONE canonical backend set of answer-shaped controls. Both the readiness contract and
 * the conversation layer use it; the frontend keeps its own API mirror.
 */
export type InteractionType = 'single_choice' | 'multiple_choice' | 'yes_no' | 'number' | 'date' | 'duration' | 'free_text';

const INTERACTION_TYPES: readonly string[] = ['single_choice', 'multiple_choice', 'yes_no', 'number', 'date', 'duration', 'free_text'];

export function isInteractionType(value: unknown): value is InteractionType {
  return typeof value === 'string' && INTERACTION_TYPES.includes(value);
}

/**
 * The EXPECTED-ANSWER contract of a requirement: the control the user is shown AND the shape
 * of answer that may safely become a fact. Domain-neutral — it says nothing about any domain
 * meaning; a Skill owns what its own needs mean.
 */
export interface RequirementInteraction {
  type: InteractionType;
  /** Allowed values for a bounded categorical (single/multiple choice). */
  options?: string[];
  /** A categorical answer outside `options` may still be recorded — never as a canonical value. */
  allowOther?: boolean;
}

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
   * The requirement's EXPECTED-ANSWER contract (K23/B1.0). It is BOTH the interaction the
   * client renders AND the compatibility contract a candidate answer must satisfy before it
   * may be bound as a fact. Additive and optional — the readiness GATE itself never reads it,
   * but the conversation's binding seam does.
   */
  interaction?: RequirementInteraction;
}

export interface KnownContextItem {
  key: string;
  value: unknown;
  source: 'memory' | 'user' | 'conversation' | 'case';
  /**
   * Categorical certainty of this value. Defaults to CERTAIN for callers that do not
   * track it; UNKNOWN/UNCERTAIN values never satisfy a material requirement.
   */
  certainty?: 'CERTAIN' | 'UNCERTAIN' | 'UNKNOWN';
}

export interface MissingMaterialInformation {
  key: string;
  description: string;
  question?: QuestionSpec;
  /**
   * The requirement's OWN EXPECTED-ANSWER contract (K23/B1.0), carried through so a caller
   * can render the control AND validate the answer without a separate static lookup.
   * Additive and optional — the gate itself never reads it.
   */
  interaction?: RequirementInteraction;
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
  if (!item) return false;
  if (item.value === null || item.value === undefined || item.value === '') return false;
  // "I don't know" and hedged values are NOT knowledge: they must never close a need.
  const certainty = item.certainty ?? 'CERTAIN';
  return certainty === 'CERTAIN';
}

// ---------------------------------------------------------------------------
// B1.0 — expected-answer compatibility (the ONE canonical answer contract)
// ---------------------------------------------------------------------------

/**
 * The verdict of comparing ONE interpreted candidate against ONE requirement's contract.
 * ACCEPTED = provably the right shape (may become a CERTAIN fact); REJECTED = provably the
 * wrong shape (must not be written at all); UNKNOWN = compatibility cannot be proven either
 * way (never certainty; the need stays open). Fails closed: an absent or untrustworthy
 * contract is never permission to store a value, and inability to validate never authorizes
 * fact binding.
 */
export type AnswerCompatibility = 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isEmptyCandidate = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Allowed categorical values, filtered to non-empty strings. */
const allowedValues = (interaction: RequirementInteraction): string[] =>
  Array.isArray(interaction.options)
    ? interaction.options.filter((o): o is string => typeof o === 'string').map((o) => o.trim()).filter(Boolean)
    : [];

/**
 * Compare ONE interpreted candidate against ONE requirement's expected-answer contract.
 * Deterministic, pure, domain-neutral: it never invents a value and never widens a contract.
 */
export function validateAnswerCompatibility(
  interaction: RequirementInteraction | undefined,
  candidate: unknown,
): AnswerCompatibility {
  // No trustworthy contract: compatibility cannot be proven, so certainty is never authorized.
  if (!interaction || !isInteractionType(interaction.type)) return 'UNKNOWN';
  if (isEmptyCandidate(candidate)) return 'REJECTED';

  switch (interaction.type) {
    case 'yes_no':
      if (typeof candidate === 'boolean') return 'ACCEPTED';
      // A number where a yes/no was expected is a definite mismatch; free prose cannot be
      // proven either way (it may well express a yes/no), so it stays UNKNOWN.
      return typeof candidate === 'string' ? 'UNKNOWN' : 'REJECTED';

    case 'number':
    case 'duration': {
      if (isFiniteNumber(candidate)) return 'ACCEPTED';
      if (typeof candidate === 'boolean') return 'REJECTED';
      if (typeof candidate === 'string') {
        // Reuse the existing digit normalization + loose parse. No unit conversion is invented.
        return parseNumberLoose(normalizeDigits(candidate)) === undefined ? 'UNKNOWN' : 'ACCEPTED';
      }
      return 'REJECTED';
    }

    case 'date': {
      if (typeof candidate !== 'string') return 'UNKNOWN';
      return /^\d{4}-\d{1,2}-\d{1,2}$/.test(normalizeDigits(candidate).trim()) ? 'ACCEPTED' : 'UNKNOWN';
    }

    case 'single_choice': {
      if (typeof candidate !== 'string') return 'REJECTED';
      const value = candidate.trim();
      const options = allowedValues(interaction);
      // No trustworthy allowed-value set: insufficient contract, so never a canonical value.
      if (options.length === 0) return 'UNKNOWN';
      if (options.includes(value)) return 'ACCEPTED';
      return interaction.allowOther === true ? 'UNKNOWN' : 'REJECTED';
    }

    case 'multiple_choice': {
      if (!Array.isArray(candidate)) return 'REJECTED';
      const values = candidate
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length === 0) return 'REJECTED';
      const options = allowedValues(interaction);
      if (options.length === 0) return 'UNKNOWN';
      if (values.every((v) => options.includes(v))) return 'ACCEPTED';
      return interaction.allowOther === true ? 'UNKNOWN' : 'REJECTED';
    }

    case 'free_text':
      // An EXPLICIT free-text declaration is permissive by intent; it is never used as a
      // silent fallback for a typed need whose contract is missing or malformed.
      return typeof candidate === 'string' ? 'ACCEPTED' : 'REJECTED';

    default:
      return 'UNKNOWN';
  }
}
