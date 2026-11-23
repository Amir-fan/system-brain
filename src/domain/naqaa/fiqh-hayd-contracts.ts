/**
 * @kip
 * @module naqaa
 * @layer domain
 * @owner naqaa
 * @feature K25
 * @purpose Contracts for the Shafi'i Fiqh Reasoning Skill V1 (menstruation issue family).
 *
 * DOMAIN layer, ABOVE Core: KIP Core never learns hayd/istihabah/nifas/purity/madhhab.
 * This slice proves the SOURCE-GROUNDED pipeline (case -> knowledge need -> approved
 * retrieval -> conditions -> material gaps -> K22/K23 questions -> re-evaluation).
 * It deliberately does NOT yet produce a final ruling.
 */

import type { RequirementInteraction } from '../../core/readiness/readiness.ts';

export const FIQH_HAYD_SKILL_ID = 'naqaa.fiqh-hayd';
export const FIQH_HAYD_SKILL_VERSION = 1;

/**
 * Owner-approved source set for V1. The skill restricts retrieval to these sources
 * BY IDENTITY (resolved within the project), so an unrelated project source can
 * never ground a ruling — even when it shares the same retrieval role.
 */
export const APPROVED_SOURCE_TITLES = ['الحيض الالوكة'] as const;
export const FIQH_EVIDENCE_GAP_MESSAGE = 'الدليل المتاح غير كافٍ للإجابة.';
export const FIQH_FACT_KEY_PATTERN = '^[a-zA-Z][a-zA-Z0-9_]*$';

const NON_MATERIAL_PRESENTATION_FACT_KEYS = new Set([
  'preferredlanguage', 'language', 'locale', 'outputlanguage', 'responselanguage',
  'preferredlocale', 'outputlocale', 'responselocale',
  'outputstyle', 'responsestyle', 'preferredstyle',
  'outputformat', 'responseformat', 'preferredformat',
  'format', 'style', 'tone', 'verbosity',
]);

/**
 * Presentation preferences may shape wording, but can never authorize a personal ruling.
 * Normalization handles snake/camel/case/separator aliases; membership remains exact so a
 * clinical key merely containing one of these words is still material.
 */
export function isFiqhDecisionMaterialFactKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized.length > 0 && !NON_MATERIAL_PRESENTATION_FACT_KEYS.has(normalized);
}

/** Bounded budgets (small surface: no giant context windows). */
export const MAX_QUERIES = 5;
export const MAX_EVIDENCE_PASSAGES = 6;
export const MAX_ADJACENT_EXPANSIONS = 2;
export const MAX_REQUIREMENTS = 6;
export const MAX_CASE_CHARS = 1600;
export const MAX_PASSAGE_CHARS = 1400;

/** What the conversation hands the skill (K23 payload). */
export interface FiqhCaseInput {
  /** Known session facts (structured answers so far). */
  context?: Record<string, unknown>;
  /** The current turn's text. */
  text?: string;
  /** Generic candidate facts from the current message (Core-extracted, domain-bound here). */
  statementFacts?: Array<{
    kind: 'duration' | 'quantity' | 'boolean' | 'categorical' | 'observation';
    value: number | boolean | string;
    unit?: string;
    originalText: string;
    certainty: 'CERTAIN' | 'UNCERTAIN' | 'UNKNOWN';
    provenance: 'user_statement' | 'user_answer' | 'memory' | 'evidence';
  }>;
  /** Bounded per-fact provenance/certainty for the current case store. */
  factMeta?: Record<string, { provenance?: string; certainty?: string }>;
  /** Bounded recent turns, so the case narrative survives across turns. */
  recentTurns?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /**
   * The latest grounded terminal result of THIS conversation (bounded session state).
   * Present only when nothing material changed since; the conversation clears it on a
   * material correction, so it can never be stale.
   */
  lastGroundedResult?: {
    skillId: string;
    status: string;
    caseSignature?: string;
    decision?: string;
    explanation?: string;
    sourceTitle?: string;
    evidenceRefs: string[];
    materialFactKeys?: string[];
  };
}

/** A citable source reference. Never a paraphrase: the passage text is the source. */
export interface FiqhEvidenceRef {
  chunkId: string;
  sourceId: string;
  /** Short verbatim excerpt from the cited passage (bounded). */
  quote: string;
}

export interface FiqhInterpretation {
  observation: string;
  candidateConcept: string;
  supported: boolean;
  citations: FiqhEvidenceRef[];
}

export interface FiqhMaterialRequirement {
  key: string;
  whyMaterial: string;
  question: { wording: string };
  /** The canonical expected-answer contract of this need (see NEED_CATALOGUE). */
  interaction: RequirementInteraction;
  citations: FiqhEvidenceRef[];
  /** The model's reading of the case: the narrative already answers this need. */
  knownFromCase?: boolean;
}

/** Strict, validated JSON contract the reasoning model must return. */
export interface FiqhReasoningPlan {
  issue: string;
  queries: string[];
  interpretations: FiqhInterpretation[];
  requirements: FiqhMaterialRequirement[];
  unresolved: string[];
}


/**
 * Output budget this skill requests for its structured JSON calls. Bounded on
 * purpose: the answers are small structured objects, and an unbounded request makes
 * the provider reserve the model's whole output capacity. Domain-owned value — the
 * Model Gateway only carries it and the provider adapter only maps it.
 */
export const DECISION_MAX_OUTPUT_TOKENS = 16384;
/** Same reasoned bound for the planner/extraction calls (small structured JSON). */
export const REASONING_MAX_OUTPUT_TOKENS = 16384;

/** V1 is Shafi'i only; the madhhab never leaks into Core. */
export const MADHHAB = 'shafii' as const;

export type FiqhDecisionStatus = 'DECIDED' | 'NEEDS_INFORMATION' | 'SOURCE_GAP';
/** Categorical only — never an invented percentage. */
export type FiqhConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type FiqhSourceSupport = 'SUPPORTED' | 'PARTIAL' | 'UNSUPPORTED';

/** What the reasoning model PROPOSES (never trusted as-is: see validateDecision). */
export interface FiqhDecisionProposal {
  status?: string;
  category?: string;
  directAnswer?: string;
  explanation?: string;
  confidence?: string;
  sourceSupport?: string;
  /** Retrieved chunk ids the ruling is grounded in. */
  evidenceRefs?: string[];
  /** Exact server-admitted facts on which a personal ruling depends. */
  materialFactKeys?: string[];
  /** OBSERVATION -> FIQH CONCEPT, each with its own source support. */
  observationMappings?: Array<{ observation?: string; concept?: string; evidenceRefs?: string[] }>;
  unresolved?: Array<{ item?: string; material?: boolean; reason?: string }>;
  needsInformation?: {
    key?: string;
    whyMaterial?: string;
    question?: { wording?: string };
    interaction?: { type?: string; options?: string[]; allowOther?: boolean };
    evidenceRefs?: string[];
  };
}

/** Validated, accepted decision (what the skill may expose). */
export interface FiqhDecision {
  status: FiqhDecisionStatus;
  category?: string;
  confidence?: FiqhConfidence;
  sourceSupport: FiqhSourceSupport;
  evidenceRefs: string[];
  observationMappings?: Array<{ observation: string; concept: string; evidenceRefs: string[] }>;
  unresolved?: Array<{ item: string; material: boolean; reason?: string }>;
}

export type FiqhCaseStatus = 'NEEDS_INFORMATION' | 'READY_FOR_FIQH_DECISION' | 'SOURCE_GAP';

export interface FiqhSourceGap {
  present: boolean;
  /** Observations the approved source does not map to a fiqh concept. */
  observations: string[];
  notes: string[];
}

/** Skill output (lifted by the runtime: readiness + bounded trace). */
export interface FiqhHaydOutput {
  status: FiqhCaseStatus;
  issue?: string;
  interpretations?: Array<{ observation: string; candidateConcept: string; supported: boolean; citationIds: string[] }>;
  requirementKeys?: string[];
  sourceGap: FiqhSourceGap;
  approvedSourceIds: string[];
  evidenceChunkIds: string[];
  readiness?: unknown;
  trace?: unknown;
  /** Present when the decision step ran (DECIDED / SOURCE_GAP). */
  decision?: FiqhDecision;
  /** User-facing grounded answer (rendered by the conversation). */
  answer?: { text: string; sourceTitle?: string; evidenceIds?: string[]; label?: string };
}

/**
 * STABLE SEMANTIC NEED IDENTITY (F2). Identity, label, AND the canonical expected-answer
 * contract of each known need. The model still decides WHICH need is material for a case and
 * how the question is worded, but it can never invent an identity nor redefine a known need's
 * answer kind (B1.0 / G1): the Skill owns what its needs mean.
 */
export interface NeedDefinition {
  /** Admin/observability label. The user-facing QUESTION wording stays the model's. */
  label: string;
  /** Skill-owned canonical expected-answer contract — authoritative over any model declaration. */
  interaction: RequirementInteraction;
}

const need = (label: string, interaction: RequirementInteraction): NeedDefinition => ({ label, interaction });

export const NEED_CATALOGUE = {
  bleeding_duration_hours: need('مدة نزول الدم بالساعات', { type: 'number' }),
  bleeding_duration_days: need('مدة نزول الدم بالأيام', { type: 'number' }),
  bleeding_cessation: need('هل توقف الدم/الإفراز وانقطع', { type: 'yes_no' }),
  bleeding_contiguity: need('هل الإفراز متصل بنزول الدم', { type: 'yes_no' }),
  post_bleeding_dryness: need('هل جفّ المكان بعد الدم', { type: 'yes_no' }),
  purity_sign_seen: need('هل ظهرت علامة الطهر المعروفة', { type: 'yes_no' }),
  habit_days: need('عادة عدد أيام الدورة', { type: 'number' }),
  cycle_interval_days: need('المدة بين الدورتين', { type: 'number' }),
  age_eligibility: need('هل بلغت سن التكليف المعتبر', { type: 'yes_no' }),
  discharge_colour: need('لون الإفراز الموصوف', {
    type: 'single_choice',
    // The observable colours this domain is willing to treat as a CANONICAL value. A colour
    // outside this set is never invented into a category (allowOther keeps it uncategorised).
    options: ['أحمر', 'بني', 'أصفر', 'أسود', 'أبيض', 'شفاف'],
    allowOther: true,
  }),
  postpartum_state: need('هل الحالة بعد ولادة/نفاس', { type: 'yes_no' }),
};

export type NeedId = keyof typeof NEED_CATALOGUE;

/**
 * The Skill-owned canonical answer contract for a known need. Undefined means "not a known
 * need" — never a licence to accept an arbitrary answer.
 */
/**
 * B1.1 / K-3 — the Skill-owned SAFE-REUSE classification for persisted materiality.
 *
 * A persisted turn context means "these needs were material WHEN that context was produced" — not
 * "these needs are material now". After an accepted answer, a stored requirement may therefore be
 * reused ONLY when the Skill can POSITIVELY name the answered need as one whose answer cannot
 * change WHICH conditions the approved source requires for this case: it only fills an input value
 * for a condition that is already required.
 *
 * This is an OPTIMISATION GUARD — never the authority on materiality — and it is deliberately
 * minimal. The default is FAIL-SAFE: an unclassified (or unknown) answer always falls back to a
 * fresh full derivation. Emptying this set makes reuse fully conservative.
 *
 * CLOSURE (B1.1) — this set is EMPTY, and that is the PROVEN result, not a default.
 *
 * A key may be listed here only if it is PROVEN that no valid accepted value can alter the
 * materiality set a fresh derivation would produce. In the current architecture that is unprovable
 * for EVERY Naqaa need, because the requirement set is not produced by Skill logic at all:
 *   - the interpreter model emits it from a prompt that embeds the known facts
 *     (`JSON.stringify(known)`, fiqh-hayd-skill.ts:429), and
 *   - the planner chooses its retrieval queries from the same facts (:387), so a stored value can
 *     also change which citations exist — and an uncited requirement is dropped (:510-513).
 * No Skill code constrains the emitted set for any need value: `habit_days` and `cycle_interval_days`
 * appear ONLY in the catalogue above, never in a decision branch. So a value change could in
 * principle add, remove, re-branch or reorder requirements, which fails the proof standard.
 *
 * Deliberately excluded for the same reason: every bleeding/state observation (duration in
 * hours/days, cessation, contiguity, post-bleeding dryness, purity sign, age eligibility, colour,
 * postpartum state). Those were always the obvious cases — e.g. a duration threshold can move the
 * case into a different rule family.
 *
 * Consequence: reuse is refused for ALL Naqaa needs, and every accepted answer takes the existing
 * full derivation. The guard itself remains (a future need proven stable can be listed here WITH
 * its proof) and the default stays FAIL-SAFE.
 */
export const MATERIALITY_STABLE_NEEDS: ReadonlySet<string> = new Set<string>();

/** True ONLY for a positively classified, materiality-stable need. Anything else → false (fail-safe). */
export function isMaterialityStable(key: string): boolean {
  return MATERIALITY_STABLE_NEEDS.has(key);
}

export function canonicalInteractionFor(key: string): RequirementInteraction | undefined {
  return Object.prototype.hasOwnProperty.call(NEED_CATALOGUE, key)
    ? (NEED_CATALOGUE as unknown as Record<string, NeedDefinition>)[key]!.interaction
    : undefined;
}
