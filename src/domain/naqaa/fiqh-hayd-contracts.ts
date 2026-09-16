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

export const FIQH_HAYD_SKILL_ID = 'naqaa.fiqh-hayd';
export const FIQH_HAYD_SKILL_VERSION = 1;

/**
 * Owner-approved source set for V1. The skill restricts retrieval to these sources
 * BY IDENTITY (resolved within the project), so an unrelated project source can
 * never ground a ruling — even when it shares the same retrieval role.
 */
export const APPROVED_SOURCE_TITLES = ['الحيض الالوكة'] as const;

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
  /** Bounded recent turns, so the case narrative survives across turns. */
  recentTurns?: Array<{ role: 'user' | 'assistant'; text: string }>;
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
  interaction: { type: string; options?: string[]; allowOther?: boolean };
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
}
