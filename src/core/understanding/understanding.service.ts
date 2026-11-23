/**
 * @kip
 * @module understanding
 * @layer core
 * @owner intelligence-knowledge
 * @feature K19
 * @purpose Deterministic Understanding engine. 0 model calls in V1.
 *
 * Turns the current input (plus bounded relevant memory) into a structured
 * UnderstandingResult: dialogue act, issues, references, corrections, facts, temporal
 * normalization, material ambiguity, clarification. It never writes durable memory.
 */

import {
  UnderstandingFailure,
  correctionValuesCompatible,
  type AmbiguityResult,
  type BoundedUnderstandingContext,
  type Clarification,
  type DialogueAct,
  type ReferenceResult,
  type UnderstandingCorrection,
  type UnderstandingFact,
  type UnderstandingInput,
  type UnderstandingLanguage,
  type UnderstandingResult,
} from './understanding.ts';

const ARABIC = /[\u0600-\u06FF]/;
const QUESTION_WORDS_EN = /(?:^|[,:;.!?]\s*)(what|when|where|who|why|how|which|is|are|do|does|can|would|should|will)\b/i;
// Before a number, من can introduce a plain duration answer such as "من ٦ أيام".
// Bare ما is ambiguous between an interrogative and ordinary negation. Recognize its
// generic nominal question forms instead of treating every ما-prefixed sentence as a question.
const QUESTION_WORDS_AR = /(?:^|[،,:;؛.!?؟]\s*)(?:ماذا|كيف|متى|أين|اين|هل|لماذا|كم|من(?!\s+\p{N})|أي|ما\s+(?:هو|هي|هذا|هذه|هؤلاء|ذلك|تلك|الذي|التي|معنى|سبب|اسم|نوع|طريقة|الفرق))(?![\p{L}\p{N}_])/u;
// A question mark may be followed by closing punctuation or presentation symbols (quotes,
// emoji, variation selectors) without changing the turn into a statement.
const TERMINAL_QUESTION = /[?؟][\p{P}\p{S}\p{M}\u200D\uFE0F\s]*$/u;
const UNKNOWN_MARKERS = /(ما أدري|ما ادري|ما أعرف|ما اعرف|لا أعرف|لا اعرف|مو متأكد|مو متأكدة|مب متأكد|غير متأكد|ما أعلم|لا علم)/;
const IMPERATIVES_EN = /^(book|reserve|schedule|send|open|show|give|create|add|set|call|remind|check)\b/i;
const IMPERATIVES_AR = /^(احجز|أرسل|افتح|أعطني|أرني|أنشئ|أضف|اضبط|اذكر|ذكرني|تحقق)\b/;
const CORRECTION_MARKER = /\bi (?:mean|meant)\b|اقصد|أقصد|أعني|اعني|مقصودي|قصدي/i;
const CORRECTION_PREFACE = /^(?:no|sorry|لا|آسفة?)(?:\s*[,،]\s*|\s+)/i;
const CORRECTION_VALUE_SEPARATOR = /^(?:\s*[,،:]\s*|\s+)/;
const CORRECTION_ALTERNATIVE = /\bor\b|(?<!\p{L})(?:أو|او)(?!\p{L})/iu;
// Lexical-token match (B1.2): a deictic term counts only as a standalone token, never as a
// substring of another word — Arabic نفس inside نفساء, ذلك inside كذلك. Unicode LETTERS are the
// token class; combining marks (harakat/tanween) are not letters, so a marked standalone word
// (نفسٌ) still matches while نفساء does not. No word is special-cased.
const DEICTIC = /(?<!\p{L})(?:that one|the previous one|the same|this one|that|it|هذا|ذلك|الذي|نفسه|نفس)(?!\p{L})/u;

function detectLanguage(text: string): UnderstandingLanguage {
  if (ARABIC.test(text)) return 'ar';
  if (/[A-Za-z]{2,}/.test(text)) return 'en';
  return null;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Split a single input into distinct asks/clauses (not answered). */
function splitIssues(text: string): string[] {
  const t = normalize(text);
  // Arabic compound: "…، وما …" / "…؟ وماذا عن …"
  const ar = t.split(/[؟?]\s*(?:و|ماذا)\s*|،\s*(?:و)?(?:ماذا|ما)/);
  if (ar.length > 1) return ar.map((s) => s.trim()).filter(Boolean);
  const en = t.split(/[?;]\s*(?:and\s+)?(?:what|when|where|who|which|how|do|does)\b|\band\b(?=[^?.]*(?:\?|$))/i);
  if (en.length > 1) return en.map((s) => s.trim()).filter(Boolean);
  return [t];
}

/** Extract clock expressions as "HH:MM". */
function extractTimes(text: string): string[] {
  const normalized = normalizeDigits(text);
  const meridiem = String.raw`(?:a\.?m\.?|p\.?m\.?|مساء|صباحا|صباحاً)(?!\p{L})`;
  const arabicMeridiem = String.raw`(?:مساء|صباحا|صباحاً)(?!\p{L})`;
  const introduction = String.raw`(?<!\p{L})(?:at|في|الساعة|الساعه)(?!\p{L})`;
  const clocks = normalized.matchAll(new RegExp(
    String.raw`(?<![\d:])(?:${introduction}\s+\d{1,2}(?::\d{2})?(?:\s*${meridiem})?|\d{1,2}:\d{2}(?:\s*${meridiem})?|\d{1,2}(?::\d{2})?\s*${arabicMeridiem})(?![\d:])`,
    'giu',
  ));
  const out: string[] = [];
  for (const match of clocks) {
    let expression = match[0];
    const period = /([ap]\.?m\.?|مساء|صباحا|صباحاً)\s*$/iu.exec(expression)?.[1] ?? '';
    // In the exact undotted “At 12:30 am I free?” shape, `am` begins the local
    // question clause. A later question in another sentence must not change the
    // preceding statement's explicit meridiem.
    const following = text.slice((match.index ?? 0) + match[0].length);
    if (period.toLowerCase() === 'am' && /^\s+i\b[^.!?؟,،;؛\u2013\u2014]*[?؟]/i.test(following)) {
      expression = expression.replace(/\s*am\s*$/i, '');
    }
    const clock = parseClockExpression(expression);
    if (clock) out.push(clock);
  }
  return out;
}

/** today/tomorrow/yesterday relative to an EXPLICIT request timestamp. */
function extractTemporal(text: string, requestTimestamp?: string): UnderstandingFact[] {
  const facts: UnderstandingFact[] = [];
  if (!requestTimestamp) return facts;
  const base = new Date(requestTimestamp);
  if (Number.isNaN(base.getTime())) return facts;
  const isoDay = (offset: number) => {
    const d = new Date(base.getTime() + offset * 86400000);
    return d.toISOString().slice(0, 10);
  };
  if (/\b(today|اليوم)\b/i.test(text)) facts.push({ key: 'date', value: isoDay(0), original: 'today' });
  if (/\b(tomorrow|غداً|غدا|بكرة)\b/i.test(text)) facts.push({ key: 'date', value: isoDay(1), original: 'tomorrow' });
  if (/\b(yesterday|أمس|امس)\b/i.test(text)) facts.push({ key: 'date', value: isoDay(-1), original: 'yesterday' });
  return facts;
}

function detectDialogueAct(t: string): DialogueAct {
  if (t.length === 0) return 'OTHER';
  const followUp = /^(وماذا|و ماذا|وبالنسبة|ماذا عن|وكذلك|what about|and what about|also what about)/i.test(t) || /^(و|وا)\s*(ماذا|كيف)/.test(t);
  // Question punctuation takes precedence over wording that resembles a correction or confirmation.
  if (TERMINAL_QUESTION.test(t)) return followUp ? 'FOLLOW_UP' : 'QUESTION';
  // Confirmation with explicit intent ("Yes, that's what I meant.", "نعم هذا ما أقصد").
  if (/^(نعم|أجل|صحيح|نعم هذا ما|yes,? that's? what i meant|yes,? that|yeah|exactly|correct)\b/i.test(t)
    || /^yes[^.]*that[^.]*(what i|meant)/i.test(t)
    || /^نعم[^.]*هذا/.test(t)) return 'CONFIRMATION';
  if (followUp) return 'FOLLOW_UP';
  const unmarked = t.replace(/\p{M}/gu, '');
  if (QUESTION_WORDS_EN.test(t) || (QUESTION_WORDS_AR.test(unmarked) && UNKNOWN_MARKERS.exec(unmarked)?.index !== 0)) return 'QUESTION';
  // Correction ("No, I meant 10.", "أقصد العاشرة").
  if (CORRECTION_MARKER.test(t)) return 'CORRECTION';
  // Rejection ("No, not that one.", "ليس هذا").
  if (/\b(not that|that's not|not this|wrong)\b/i.test(t) || /ليس هذا|ليس ذلك|لا هذا|ليس هذا ما|هذا ليس/.test(t)) return 'REJECTION';
  // Command.
  if (IMPERATIVES_AR.test(t) || IMPERATIVES_EN.test(t)) return 'COMMAND';
  return 'STATEMENT';
}

function detectCorrections(text: string, context: BoundedUnderstandingContext): UnderstandingCorrection[] {
  const explicit = text.replace(CORRECTION_PREFACE, '');
  const marker = CORRECTION_MARKER.exec(explicit);
  if (!marker || marker.index !== 0) return [];
  const suffix = explicit.slice(marker[0].length);
  const separator = CORRECTION_VALUE_SEPARATOR.exec(suffix);
  if (!separator) return [];
  const replacement = suffix.slice(separator[0].length).trim().replace(/[.!?؟]+$/, '');
  if (!replacement || CORRECTION_ALTERNATIVE.test(replacement)) return [];
  const clock = parseCorrectionClock(replacement);
  // A time mentioned inside negation or speculation is not a definite replacement.
  if (!clock && extractTimes(normalizeDigits(replacement)).length > 0) return [];
  const newValue = clock ?? replacement;
  // Resolve across every bounded scope, but only when exactly one fact has the same
  // recognized scalar type. This handles session facts while refusing to guess among
  // two dates (or to overwrite an arbitrary free-form string).
  const matches = [...context.user, ...context.conversation, ...context.case]
    .filter((memory) => correctionValuesCompatible(memory.payload.value, newValue));
  if (matches.length > 1) return [{ new: newValue, targetAmbiguous: true }];
  if (matches.length === 0) return [{ new: newValue }];

  const target = matches[0];
  return [{ target: target.memoryKey, old: String(target.payload.value), new: newValue }];
}

function resolveReferences(text: string, context: BoundedUnderstandingContext): ReferenceResult {
  if (!DEICTIC.test(text)) return { resolved: true };
  const candidates = [...context.user, ...context.conversation, ...context.case];
  if (candidates.length === 1) return { resolved: true, referent: candidates[0].memoryKey };
  // B1.2: with ZERO candidates there is no referent the user could name, so a referent question
  // would be unanswerable. It stays unresolved (a rejection still needs its alternative question)
  // but is explicitly NOT a clarification-worthy reference ambiguity. Multiple candidates are.
  return { resolved: false, needsClarification: candidates.length > 1 };
}

function materialAmbiguity(text: string, references: ReferenceResult): AmbiguityResult {
  if (references.resolved) return { material: false };
  // Only an ambiguity the user can actually resolve is material (B1.2): a deictic token with no
  // candidate referent has nothing to disambiguate, so it must not block the turn.
  if (references.needsClarification !== true) return { material: false };
  return { material: true, reason: 'unresolved_reference' };
}

function clarificationFor(text: string, refs: ReferenceResult, act: DialogueAct): Clarification {
  // B1.2: the referent question is only askable when a candidate set actually exists. With none it
  // is unanswerable, so a rejection gets its answerable alternative question instead.
  if (!refs.resolved && refs.needsClarification === true) {
    return { reason: 'unresolved_reference', question: 'إلى أي عنصر تشير بالضبط؟', candidates: [] };
  }
  if (act === 'REJECTION') {
    return { reason: 'unknown_alternative', question: 'ما هو الخيار الذي تقصده بدلاً من ذلك؟' };
  }
  return { reason: 'material_ambiguity', question: 'أرجو توضيح قصدك حتى أتمكن من المتابعة.' };
}


const HEDGE_MARKERS = /(غالبا|غالبًا|تقريبا|تقريبًا|ربما|يمكن|أظن|اظن|لعل|مو متأكد|مو متأكدة)/;
/** A speculative clause must never become current case truth (Slice B owns full F5). */
const HYPOTHETICAL_MARKERS = /(^|\s)(لو|اذا|إذا|بفرض|في حال)(\s|$)/;

/**
 * Generic candidate-fact extraction. Domain-free by construction: quantities with a time
 * unit become a duration, cessation verbs a boolean, "I don't know" an UNKNOWN categorical,
 * hedged/hypothetical language and mentions in questions lower certainty.
 * Interpretation ("is this enough for X?") is never done here.
 */
function extractCandidates(text: string, dialogueAct: DialogueAct): CandidateFact[] {
  const normalized = normalizeDigits(text);
  const unknown = UNKNOWN_MARKERS.test(text);
  const hedged = HEDGE_MARKERS.test(text);
  const hypothetical = HYPOTHETICAL_MARKERS.test(text);
  const question = dialogueAct === 'QUESTION' || dialogueAct === 'FOLLOW_UP';
  const certainty: FactCertainty = unknown ? 'UNKNOWN' : hedged || hypothetical || question ? 'UNCERTAIN' : 'CERTAIN';
  const out: CandidateFact[] = [];

  const UNITS: Array<[RegExp, string]> = [
    [/(ساعات|ساعتان|ساعتين|ساعة|ساعه|ساعه)/, 'hour'],
    [/(أيام|ايام|يومين|يوم)/, 'day'],
    [/(أسابيع|اسابيع|أسبوع|اسبوع)/, 'week'],
    [/(شهور|أشهر|اشهر|شهر)/, 'month'],
    [/(دقائق|دقيقة|دقيقه)/, 'minute'],
  ];
  for (const m of text.matchAll(/([0-9٠-٩۰-۹]+(?:[.][0-9٠-٩۰-۹]+)?)\s*([؀-ۿ]+)/g)) {
    const n = parseNumberLoose(m[1]);
    if (n === undefined || !Number.isFinite(n)) continue;
    const word = m[2];
    const unit = UNITS.find(([re]) => re.test(word))?.[1];
    if (!unit) continue;
    out.push({ kind: 'duration', value: n, unit, originalText: m[0].slice(0, 60), certainty, provenance: 'user_statement' });
  }
  const stop = /(وقف|توقف|توقّف|انقطع|جفّ|جف |نشف|اختفت)/.exec(text);
  if (stop) {
    out.push({ kind: 'boolean', value: true, originalText: stop[0].slice(0, 60), certainty, provenance: 'user_statement' });
  }
  if (unknown) {
    out.push({ kind: 'categorical', value: 'UNKNOWN', originalText: UNKNOWN_MARKERS.exec(text)?.[0]?.slice(0, 60) ?? 'unknown', certainty: 'UNKNOWN', provenance: 'user_statement' });
  }
  if (out.length === 0) {
    const q = parseNumberLoose(text);
    if (q !== undefined) out.push({ kind: 'quantity', value: q, originalText: String(q), certainty, provenance: 'user_statement' });
  }
  const obs = text.trim().slice(0, 200);
  if (obs) out.push({ kind: 'observation', value: obs, originalText: obs, certainty, provenance: 'user_statement' });

  return out.slice(0, 8);
}

import type { CandidateFact, FactCertainty } from './understanding.ts';
import { normalizeDigits, parseClockExpression, parseCorrectionClock, parseNumberLoose } from './numbers.ts';
export class UnderstandingService {
  /** Deterministic: no model call. */
  async evaluate(input: UnderstandingInput): Promise<UnderstandingResult> {
    const text = normalize(input.text);
    if (text.length === 0) throw new UnderstandingFailure('UNDERSTANDING_TEXT_EMPTY');

    const context: BoundedUnderstandingContext = input.context ?? { user: [], conversation: [], case: [] };
    const language = detectLanguage(text);
    const dialogueAct = detectDialogueAct(text);
    const issues = splitIssues(text);
    const corrections = dialogueAct === 'CORRECTION' ? detectCorrections(text, context) : [];
    const references = resolveReferences(text, context);
    const ambiguity = materialAmbiguity(text, references);

    const facts: UnderstandingFact[] = [];
    const [time] = extractTimes(text);
    if (time) facts.push({ key: 'time', value: time, original: /([\d:]+)/.exec(text)?.[0] ?? text });
    facts.push(...extractTemporal(text, input.requestTimestamp));

    // Confirmation/rejection may need clarification when the alternative is unknown.
    // A bare confirmation ("Yes, that's what I meant") refers to the system's pending
    // interpretation — it does NOT need a resolvable memory referent.
    let status: UnderstandingResult['status'] = 'CLEAR';
    let clarification: Clarification | undefined;
    const materialForStatus = dialogueAct === 'CONFIRMATION' ? false : ambiguity.material;
    const rejectionUnknown = dialogueAct === 'REJECTION' && !references.resolved && corrections.length === 0;
    if (materialForStatus || rejectionUnknown) {
      status = 'NEEDS_CLARIFICATION';
      clarification = clarificationFor(text, references, dialogueAct);
    }

    return {
      status,
      language,
      dialogueAct,
      issues: issues.length > 0 ? issues : [text],
      references,
      corrections,
      facts,

      candidates: extractCandidates(text, dialogueAct),
      ambiguity,
      ...(clarification ? { clarification } : {}),
      contextUsed: {
        userCount: context.user.length,
        conversationCount: context.conversation.length,
        caseCount: context.case.length,
        scopes: [
          ...(context.user.length ? ['user'] : []),
          ...(context.conversation.length ? ['conversation'] : []),
          ...(context.case.length ? ['case'] : []),
        ],
      },
    };
  }
}
