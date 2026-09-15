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
const QUESTION_WORDS_EN = /^(what|when|where|who|why|how|which|is|are|do|does|can|would|should|will)\b/i;
const QUESTION_WORDS_AR = /^(ما|ماذا|كيف|متى|أين|اين|هل|لماذا|كم|من|أي)\b/;
const IMPERATIVES_EN = /^(book|reserve|schedule|send|open|show|give|create|add|set|call|remind|check)\b/i;
const IMPERATIVES_AR = /^(احجز|أرسل|افتح|أعطني|أرني|أنشئ|أضف|اضبط|اذكر|ذكرني|تحقق)\b/;
const DEICTIC = /\b(that one|that|the previous one|the same|this one|it)\b|(هذا|ذلك|الذي|نفسه|نفس)/;

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

/** Minimal time extraction -> "HH:MM". */
function extractTime(text: string): string | undefined {
  const colon = /(\d{1,2}):(\d{2})/.exec(text);
  if (colon) return `${colon[1].padStart(2, '0')}:${colon[2]}`;
  const bare = /(?:at|في|الساعة|الساعه)\s+(\d{1,2})(?:\s*(am|pm|مساء|صباحا|صباحاً))?/i.exec(text);
  if (bare) {
    let h = Number(bare[1]);
    if (/pm|مساء/.test(bare[2] ?? '') && h < 12) h += 12;
    if (/am|صباحا|صباحاً/.test(bare[2] ?? '') && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:00`;
  }
  return undefined;
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

function detectDialogueAct(text: string, context: BoundedUnderstandingContext): DialogueAct {
  const t = normalize(text);
  if (t.length === 0) return 'OTHER';
  // Confirmation with explicit intent ("Yes, that's what I meant.", "نعم هذا ما أقصد").
  if (/^(نعم|أجل|صحيح|نعم هذا ما|yes,? that's? what i meant|yes,? that|yeah|exactly|correct)\b/i.test(t)
    || /^yes[^.]*that[^.]*(what i|meant)/i.test(t)
    || /^نعم[^.]*هذا/.test(t)) return 'CONFIRMATION';
  // Correction ("No, I meant 10.", "أقصد العاشرة").
  if (/\b(i mean|i meant)\b/i.test(t) || /اقصد|أقصد|أعني|اعني|مقصودي|قصدي/.test(t)) return 'CORRECTION';
  // Rejection ("No, not that one.", "ليس هذا").
  if (/\b(not that|that's not|not this|wrong)\b/i.test(t) || /ليس هذا|ليس ذلك|لا هذا|ليس هذا ما|هذا ليس/.test(t)) return 'REJECTION';
  // Follow-up.
  if (/^(وماذا|و ماذا|وبالنسبة|ماذا عن|وكذلك|what about|and what about|also what about)/i.test(t) || /^(و|وا)\s*(ماذا|كيف)/.test(t)) return 'FOLLOW_UP';
  // Question.
  if (t.endsWith('؟') || t.endsWith('?') || QUESTION_WORDS_AR.test(t) || QUESTION_WORDS_EN.test(t)) return 'QUESTION';
  // Command.
  if (IMPERATIVES_AR.test(t) || IMPERATIVES_EN.test(t)) return 'COMMAND';
  return 'STATEMENT';
}

function detectCorrections(text: string, context: BoundedUnderstandingContext): UnderstandingCorrection[] {
  const newValue = extractTime(text) ?? /^\s*لا،?\s*(?:أقصد|أعني|اقصد|اعني|i mean|i meant)\s+(.+)$/i.exec(text)?.[1]?.trim();
  if (newValue === undefined) return [];
  // Find the most relevant active preference in user memory context. When the new
  // value is a time, prefer the preference whose existing value is also a time (e.g.
  // correcting preferred_time 09:00 -> 10:00), then fall back to the first preference.
  const prefs = context.user.filter((m) => /preference/i.test(m.memoryType) || /preferred|time|date/i.test(m.memoryKey));
  if (prefs.length === 0) {
    return [{ new: newValue }];
  }
  const isTime = (v: unknown) => typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v);
  const target = prefs.find((m) => isTime((m.payload as Record<string, unknown>).value) && isTime(newValue)) ?? prefs[0];
  return [{ target: target.memoryKey, old: String((target.payload as Record<string, unknown>).value ?? ''), new: newValue }];
}

function resolveReferences(text: string, context: BoundedUnderstandingContext): ReferenceResult {
  if (!DEICTIC.test(text)) return { resolved: true };
  const candidates = [...context.user, ...context.conversation, ...context.case];
  if (candidates.length === 1) return { resolved: true, referent: candidates[0].memoryKey };
  if (candidates.length === 0) return { resolved: false, needsClarification: true };
  return { resolved: false, needsClarification: true };
}

function materialAmbiguity(text: string, references: ReferenceResult): AmbiguityResult {
  if (references.resolved) return { material: false };
  // A deictic reference with no single referent is material to the interpretation.
  return { material: true, reason: 'unresolved_reference' };
}

function clarificationFor(text: string, refs: ReferenceResult, act: DialogueAct): Clarification {
  if (!refs.resolved) {
    return { reason: 'unresolved_reference', question: 'إلى أي عنصر تشير بالضبط؟', candidates: [] };
  }
  if (act === 'REJECTION') {
    return { reason: 'unknown_alternative', question: 'ما هو الخيار الذي تقصده بدلاً من ذلك؟' };
  }
  return { reason: 'material_ambiguity', question: 'أرجو توضيح قصدك حتى أتمكن من المتابعة.' };
}

export class UnderstandingService {
  /** Deterministic: no model call. */
  async evaluate(input: UnderstandingInput): Promise<UnderstandingResult> {
    const text = normalize(input.text);
    if (text.length === 0) throw new UnderstandingFailure('UNDERSTANDING_TEXT_EMPTY');

    const context: BoundedUnderstandingContext = input.context ?? { user: [], conversation: [], case: [] };
    const language = detectLanguage(text);
    const dialogueAct = detectDialogueAct(text, context);
    const issues = splitIssues(text);
    const corrections = detectCorrections(text, context);
    const references = resolveReferences(text, context);
    const ambiguity = materialAmbiguity(text, references);

    const facts: UnderstandingFact[] = [];
    const time = extractTime(text);
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
