/**
 * @kip
 * @module material-fact-admission
 * @layer core
 * @owner platform-core
 * @purpose The sole deterministic authorization seam for turning an explicit user
 *          response into a material fact. Linguistic classification and extracted
 *          candidates are advisory and never enter this interface.
 */

import { normalizeDigits, normalizeIsoDate, parseCorrectionClock } from '../understanding/numbers.ts';
import { correctionValuesCompatible, normalizeBooleanAnswer, normalizeCorrectionValue, type UnderstandingCorrection } from '../understanding/understanding.ts';
import {
  hasContextValue,
  isInteractionType,
  isUncertaintyValue,
  validateAnswerCompatibility,
  type RequirementInteraction,
} from './readiness.ts';

export type MaterialAnswerSource = 'structured' | 'raw';

export type MaterialAnswerAdmission =
  | { outcome: 'accepted'; value: unknown; certainty: 'CERTAIN' }
  | { outcome: 'unknown'; value: 'UNKNOWN'; certainty: 'UNKNOWN' }
  | { outcome: 'ignored' };

const WHOLE_NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const WHOLE_DURATION = /^(\+?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:minutes?|hours?|days?|weeks?|months?|دقائق|دقيقة|دقيقه|ساعات|ساعتان|ساعتين|ساعة|ساعه|أيام|ايام|يومين|يوم|أسابيع|اسابيع|أسبوع|اسبوع|شهور|أشهر|اشهر|شهر)$/iu;
const EXPLICIT_CORRECTION = /^(?:(?:no|sorry|لا|آسفة|آسفه|اسفة)(?:\s*[,،]\s*|\s+))?(?:i\s+(?:mean|meant)|اقصد|أقصد|أعني|اعني|مقصودي|قصدي)(?:\s*[,،:]\s*|\s+)(.+)$/iu;
const QUESTION_MARK = /[?؟？⁇⁈⁉]/u;

function containsUncertainty(value: unknown): boolean {
  return Array.isArray(value) ? value.some(isUncertaintyValue) : isUncertaintyValue(value);
}

function parseNumber(value: string): number | undefined {
  if (!WHOLE_NUMBER.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseDuration(value: string): string | number | undefined {
  const normalized = normalizeDigits(value);
  const number = parseNumber(normalized);
  if (number !== undefined) return number >= 0 ? number : undefined;
  const match = WHOLE_DURATION.exec(normalized);
  return match && Number.isFinite(Number(match[1])) ? value : undefined;
}

function parseTextValue(interaction: RequirementInteraction, value: string): unknown {
  switch (interaction.type) {
    case 'yes_no': return normalizeBooleanAnswer(value);
    case 'number': return parseNumber(normalizeDigits(value));
    case 'duration': return parseDuration(value);
    case 'date': return normalizeIsoDate(value);
    case 'time': return parseCorrectionClock(value);
    case 'single_choice': return value;
    case 'multiple_choice':
      return validateAnswerCompatibility(interaction, [value]) === 'ACCEPTED'
        ? [value]
        : value.split(/[,،]/u).map((option) => option.trim());
    case 'free_text': return undefined;
  }
}

/**
 * Admit one response against a server-owned expected-answer contract. Raw text receives
 * only the finite, whole-value grammar of its closed interaction type.
 */
export function admitMaterialAnswer(input: {
  interaction: RequirementInteraction | undefined;
  source: MaterialAnswerSource;
  value: unknown;
  /** A named withdrawal of an existing confirmation can remove certainty without a contract. */
  allowWithdrawal?: boolean;
}): MaterialAnswerAdmission {
  const { interaction, source, value } = input;
  if (source === 'structured' && input.allowWithdrawal && containsUncertainty(value)) {
    return { outcome: 'unknown', value: 'UNKNOWN', certainty: 'UNKNOWN' };
  }
  if (!interaction || !isInteractionType(interaction.type)) return { outcome: 'ignored' };
  if (source === 'raw' && typeof value !== 'string') return { outcome: 'ignored' };
  if (containsUncertainty(value)) return { outcome: 'unknown', value: 'UNKNOWN', certainty: 'UNKNOWN' };

  let candidate = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (source === 'structured' && interaction.type === 'multiple_choice') return { outcome: 'ignored' };
    if (source === 'structured' && interaction.type === 'free_text') {
      if (text.length > 200) return { outcome: 'ignored' };
      candidate = text;
    } else candidate = parseTextValue(interaction, text);
  } else if (interaction.type === 'duration' && typeof value === 'number' && value < 0) {
    return { outcome: 'ignored' };
  }
  if (interaction.type === 'multiple_choice' && Array.isArray(candidate)) {
    if (!candidate.every((option) => typeof option === 'string' && option.trim() !== '')) return { outcome: 'ignored' };
    candidate = candidate.map((option: string) => option.trim());
  }
  if (containsUncertainty(candidate)) return { outcome: 'unknown', value: 'UNKNOWN', certainty: 'UNKNOWN' };
  return hasContextValue(candidate) && validateAnswerCompatibility(interaction, candidate) === 'ACCEPTED'
    ? { outcome: 'accepted', value: candidate, certainty: 'CERTAIN' }
    : { outcome: 'ignored' };
}

function legacyContract(value: unknown): RequirementInteraction | undefined {
  if (typeof value === 'boolean') return { type: 'yes_no' };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number' };
  return undefined;
}

type MaterialCorrectionAdmission =
  | { outcome: 'accepted'; key: string; value: unknown; interaction: RequirementInteraction }
  | { outcome: 'unproven_contract'; key: string };

/** A correction needs one compatible target. Understanding may veto ambiguity, but cannot select a target for us. */
export function admitMaterialCorrection(input: {
  text: string;
  proposals: readonly UnderstandingCorrection[];
  facts: Readonly<Record<string, unknown>>;
  /** Outstanding interaction, including one whose owner cannot authorize this correction. */
  pendingKey?: string;
  /** Every contract that makes this fact a plausible target, regardless of mutation authority. */
  contractsFor?: (key: string) => readonly RequirementInteraction[];
  /** The contract the current execution is authorized to use for mutation. */
  contractFor: (key: string) => RequirementInteraction | undefined;
  canCorrectLegacyFact?: (key: string) => boolean;
}): MaterialCorrectionAdmission | undefined {
  const { text, proposals, facts, pendingKey, contractFor } = input;
  const [proposal] = proposals;
  if (proposals.length > 1 || proposal?.targetAmbiguous || QUESTION_MARK.test(text)) return undefined;
  const replacement = EXPLICIT_CORRECTION.exec(text.replace(/\s+/g, ' ').trim().replace(/[.!]$/u, '').trim())?.[1];
  if (!replacement) return undefined;
  const proposed = parseCorrectionClock(replacement) ?? normalizeCorrectionValue(replacement);
  const keys = new Set(Object.keys(facts));
  if (pendingKey) keys.add(pendingKey);

  type Target =
    | { outcome: 'accepted'; key: string; value: unknown; interaction: RequirementInteraction; previousValue: unknown }
    | { outcome: 'unproven_contract'; key: string };
  const matches: Target[] = [];
  for (const key of keys) {
    const previous = facts[key];
    const recoverableLegacyInteraction = input.canCorrectLegacyFact?.(key) ? legacyContract(previous) : undefined;
    const authorizedInteraction = contractFor(key) ?? recoverableLegacyInteraction;
    const declaredInteractions = input.contractsFor?.(key)
      ?? (authorizedInteraction ? [authorizedInteraction] : []);
    const interactions = declaredInteractions.length > 0
      ? declaredInteractions
      : (recoverableLegacyInteraction ? [recoverableLegacyInteraction] : []);
    if (interactions.length === 0) {
      // A legacy string can be a literal choice or free text. It remains a plausible
      // target, but cannot be rewritten without a recoverable contract.
      if (Object.hasOwn(facts, key) && input.canCorrectLegacyFact?.(key)) {
        const normalizedPrevious = normalizeCorrectionValue(previous);
        if (normalizedPrevious !== proposed && correctionValuesCompatible(normalizedPrevious, proposed)) {
          matches.push({ outcome: 'unproven_contract', key });
        }
      }
      continue;
    }
    const compatible = interactions.flatMap((interaction) => {
      const admission = admitMaterialAnswer({ interaction, source: 'raw', value: replacement });
      if (admission.outcome !== 'accepted') return [];
      const prior = admitMaterialAnswer({ interaction, source: 'structured', value: previous });
      if (key !== pendingKey && prior.outcome !== 'accepted') return [];
      return [{ interaction, value: admission.value, previousValue: prior.outcome === 'accepted' ? prior.value : previous }];
    });
    if (compatible.length === 0) continue;
    const normalizedValues = new Set(compatible.map((candidate) => JSON.stringify(candidate.value)));
    if (normalizedValues.size !== 1) return undefined;

    const authorized = authorizedInteraction
      ? compatible.find((candidate) => JSON.stringify(candidate.interaction) === JSON.stringify(authorizedInteraction))
      : undefined;
    if (authorized) matches.push({ outcome: 'accepted', key, ...authorized });
    else matches.push({ outcome: 'unproven_contract', key });
  }

  if (matches.length !== 1) return undefined;
  const [match] = matches;
  if (proposal?.target && proposal.target !== match.key) return undefined;
  if (match.outcome === 'unproven_contract') {
    return input.canCorrectLegacyFact?.(match.key) ? match : undefined;
  }
  const { key, value, interaction, previousValue } = match;
  return JSON.stringify(previousValue) === JSON.stringify(value) ? undefined : { outcome: 'accepted', key, value, interaction };
}

/** The single predicate used before a material fact may authorize a personal label. */
export function isConfirmedMaterialFact(value: unknown, meta: unknown, interaction?: RequirementInteraction): boolean {
  return !!meta && typeof meta === 'object'
    && 'certainty' in meta && meta.certainty === 'CERTAIN'
    && 'provenance' in meta && meta.provenance === 'user_answer'
    && hasContextValue(value)
    && (interaction === undefined || admitMaterialAnswer({ interaction, source: 'structured', value }).outcome === 'accepted');
}
