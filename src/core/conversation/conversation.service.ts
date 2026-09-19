/**
 * @kip
 * @module conversation
 * @layer core
 * @owner platform-core
 * @feature K23
 * @purpose The small conversation orchestrator: create a session, run a turn through
 *          Understanding -> (policy-gated) context assembly -> Skill (K22 readiness
 *          gate inside) -> structured response. Deterministic; no model calls.
 *
 * Context policy is enforced HERE: PRIVATE sessions never read or write personal K18
 * Memory; session-local facts stay in the session and never become personal Memory.
 */

import {
  ConversationFailure,
  MAX_RECENT_TURNS,
  emptySessionContext,
  policyFor,
  type ConversationMessageInput,
  type ConversationResponse,
  type ConversationSession,
  type ConversationStage,
  type InteractionSpec,
  type InteractionType,
  type SessionContext,
} from './conversation.ts';
import type { UnderstandingResult } from '../understanding/understanding.ts';
import type { BoundedUnderstandingContext, MemoryReference } from '../understanding/understanding.ts';
import type { SkillExecutionResult } from '../skill/skill.ts';
import {
  validateAnswerCompatibility,
  type AnswerCompatibility,
  type DecisionRequirement,
  type RequirementInteraction,
} from '../readiness/readiness.ts';

export interface ConversationStoragePort {
  create(session: ConversationSession): Promise<ConversationSession>;
  get(projectId: string, actorSubject: string, conversationId: string): Promise<ConversationSession | null>;
  save(session: ConversationSession): Promise<ConversationSession>;
}

export interface ConversationDeps {
  persistence: ConversationStoragePort;
  understanding: { evaluate(input: { projectId: string; text: string; context?: BoundedUnderstandingContext }): Promise<UnderstandingResult> };
  skills: { execute(input: { projectId: string; actor: string; skillId: string; payload: unknown }): Promise<SkillExecutionResult> };
  /** Bounded personal Memory (K18) — consulted ONLY when policy allows (contextual). */
  memory?: { fetchBounded(projectId: string, ids: { subjectId?: string }): Promise<BoundedUnderstandingContext> };
  /** The skill a conversation invokes by default. */
  defaultSkillId: string;
  /** Interaction hints per skill requirement (from the skill's declared readiness). */
  interactionsFor?: (skillId: string) => Record<string, RequirementInteraction>;
}

function factsToContext(facts: Record<string, unknown>): BoundedUnderstandingContext {
  const conversation: MemoryReference[] = Object.entries(facts).map(([key, value]) => ({
    id: 'session:' + key, scope: 'conversation', memoryType: 'session', memoryKey: key, payload: { value },
  }));
  return { user: [], conversation, case: [] };
}

/** Does the raw text look like a plain value for the pending requirement? */
/**
 * Interpret a free-text answer to a pending question. It must NEVER silently disappear:
 * numbers/yes/no are certain, an unknown marker is UNKNOWN, and any other meaningful text
 * is preserved as an UNCERTAIN value the domain can bind safely.
 */
const UNKNOWN_ANSWER = /^(UNKNOWN|ما أدري|ما ادري|ما أعرف|ما اعرف|لا أعرف|لا اعرف|مو متأكد|مو متأكدة|مب متأكد|ما أعلم|لا علم)$/;

function interpretPlainAnswer(text: string): { value: unknown; certainty: FactCertainty } | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(normalizeDigits(t))) {
    const n = parseNumberLoose(t);
    if (n !== undefined) return { value: n, certainty: 'CERTAIN' };
  }
  if (/^(نعم|أجل|اجل|صحيح|yes|y)$/i.test(t)) return { value: true, certainty: 'CERTAIN' };
  if (/^(لا|no|n|ليس)$/i.test(t)) return { value: false, certainty: 'CERTAIN' };
  if (/(ما أدري|ما ادري|ما أعرف|ما اعرف|لا أعرف|لا اعرف|مو متأكد|مو متأكدة|مب متأكد|ما أعلم|لا علم)/.test(t)) {
    return { value: 'UNKNOWN', certainty: 'UNKNOWN' };
  }
  if (/(غالبا|غالبًا|تقريبا|تقريبًا|ربما|يمكن|أظن|اظن)/.test(t)) return { value: t.slice(0, 200), certainty: 'UNCERTAIN' };
  return { value: t.slice(0, 200), certainty: 'UNCERTAIN' };
}

/** Guarded digest of the case state a grounded result may depend on. */
function caseSignature(
  facts: Record<string, unknown>,
  meta: Record<string, { provenance: string; certainty: string }>,
): string {
  const parts = Object.keys(facts)
    .sort()
    .map((k) => `${k}=${JSON.stringify(facts[k])}|${meta[k]?.certainty ?? 'CERTAIN'}|${meta[k]?.provenance ?? 'user_answer'}`);
  let h = 5381;
  const json = parts.join(';');
  for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${json.length}`;
}

function parsePlainValue(text: string): unknown | undefined {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^(نعم|yes|صحيح)$/i.test(t)) return true;
  if (/^(لا|no)$/i.test(t)) return false;
  return undefined;
}

import type { CaseFactMeta } from './conversation.ts';
import type { FactCertainty } from '../understanding/understanding.ts';
import { normalizeDigits, parseNumberLoose } from '../understanding/numbers.ts';
export class ConversationService {
  constructor(private readonly deps: ConversationDeps) {}

  async create(projectId: string, actor: string, mode: 'contextual' | 'private'): Promise<ConversationSession> {
    const now = new Date().toISOString();
    return this.deps.persistence.create({
      id: crypto.randomUUID(), projectId, actorSubject: actor, mode, status: 'active',
      sessionContext: emptySessionContext(), createdAt: now, updatedAt: now,
    });
  }

  async handleMessage(projectId: string, actor: string, conversationId: string, input: ConversationMessageInput): Promise<ConversationResponse> {
    if (typeof input.text !== 'string' || input.text.trim().length === 0) {
      throw new ConversationFailure('CONVERSATION_INPUT_INVALID', 'text required');
    }
    const session = await this.deps.persistence.get(projectId, actor, conversationId);
    if (!session) throw new ConversationFailure('CONVERSATION_NOT_FOUND');
    if (session.status !== 'active') throw new ConversationFailure('CONVERSATION_NOT_FOUND', 'closed');

    const policy = policyFor(session.mode);
    const stages: ConversationStage[] = [];

    // 1. Incorporate the user's turn into session-local facts (bounded).
    const facts: Record<string, unknown> = { ...session.sessionContext.facts };
    const meta: Record<string, CaseFactMeta> = { ...(session.sessionContext.factMeta ?? {}) };
    const nowIso = new Date().toISOString();
    // EXPLICIT precedence (lowest → highest): memory < user_statement < user_answer.
    // A current user input is never silently overridden by Memory.
    const RANK: Record<string, number> = { memory: 0, evidence: 1, user_statement: 2, user_answer: 3 };
    const writtenKeys: string[] = [];
    const writeFact = (
      key: string,
      value: unknown,
      certainty: FactCertainty,
      provenance: CaseFactMeta['provenance'],
      original?: string,
    ): void => {
      writtenKeys.push(String(key));
      const prev = meta[key];
      if (prev && RANK[prev.provenance] > RANK[provenance] && prev.certainty === 'CERTAIN') return; // never downgrade a stronger current value
      const superseded = prev
        ? [...(prev.superseded ?? []), { value: String(prev.certainty === 'CERTAIN' ? prev.at : 'unknown'), at: prev.at }].slice(-2)
        : undefined;
      facts[key] = value;
      meta[key] = { provenance, certainty, at: nowIso, ...(original ? { original } : {}), ...(superseded ? { superseded } : {}) };
    };
    // B1.0 — ONE canonical expected-answer contract per pending/answered need. The persisted
    // requirement (B3a turn context) wins; the skill's static interaction hints are the fallback.
    // A need with no trustworthy contract can never be fast-bound: the candidate is not provable.
    const skillId = input.skillId ?? this.deps.defaultSkillId;
    const contractFor = (key: string): RequirementInteraction | undefined =>
      session.sessionContext.skillContext?.requirements.find((r) => r.key === key)?.interaction ??
      this.deps.interactionsFor?.(skillId)?.[key];

    /**
     * Bind ONLY a candidate proven compatible with the requirement's contract.
     * REJECTED is inert: nothing is written and the key is never counted as answered (an
     * invalid candidate can neither create nor overwrite a fact). UNKNOWN keeps the answer as
     * NON-certain, so it never closes a need and never becomes invented certainty.
     */
    const bindValidated = (key: string, candidate: unknown, verdict: AnswerCompatibility, original?: string): boolean => {
      if (verdict === 'REJECTED') return false;
      if (verdict === 'UNKNOWN') {
        // Not provably compatible: it must never overwrite a fact that is already certain.
        if (meta[key]?.certainty === 'CERTAIN') return false;
        writeFact(key, typeof candidate === 'string' ? candidate.slice(0, 200) : candidate, 'UNCERTAIN', 'user_answer', original);
        return false;
      }
      writeFact(key, candidate, 'CERTAIN', 'user_answer', original);
      return true;
    };

    if (Array.isArray(input.answers)) {
      for (const a of input.answers) {
        if (a && typeof a.key === 'string' && a.value !== undefined && a.value !== null && String(a.value).trim() !== '') {
          const raw = String(a.value).trim();
          // An explicit "I don't know" is never a value and never certainty.
          if (a.value === 'UNKNOWN' || UNKNOWN_ANSWER.test(raw)) {
            writeFact(a.key, 'UNKNOWN', 'UNKNOWN', 'user_answer');
            continue;
          }
          // Structured input is NOT trusted merely because it is structured: it must satisfy
          // the matching requirement's expected-answer contract.
          bindValidated(a.key, a.value, validateAnswerCompatibility(contractFor(a.key), a.value));
        }
      }
    } else if (session.sessionContext.pendingKey) {
      const pendingKey = session.sessionContext.pendingKey;
      const parsed = interpretPlainAnswer(input.text);
      if (parsed !== undefined) {
        const original = input.text.trim().slice(0, 120);
        if (parsed.certainty === 'UNKNOWN') writeFact(pendingKey, 'UNKNOWN', 'UNKNOWN', 'user_answer', original);
        else bindValidated(pendingKey, parsed.value, validateAnswerCompatibility(contractFor(pendingKey), parsed.value), original);
      }
    }

    // 2. Understanding (K19) — with bounded session context.
    stages.push('UNDERSTANDING');
    const understanding = await this.deps.understanding.evaluate({ projectId, text: input.text, context: factsToContext(facts) });

    // 2b. K19 returns a correction as a STRUCTURED interpretation; the session does
    // not silently write Memory, but the session context is the explicit owner of
    // "facts supplied in THIS session", so a corrected value replaces that session
    // fact here and readiness recomputes from it. The target is the requirement the
    // conversation last asked for, unless K19 resolved a different known fact.
    let invalidatedGrounded = false;
    let invalidationReason: string | undefined;
    for (const correction of understanding.corrections) {
      const value = correction.new;
      if (value === undefined || value === null || String(value).trim() === '') continue;
      const target =
        correction.target && Object.prototype.hasOwnProperty.call(facts, correction.target)
          ? correction.target
          : session.sessionContext.pendingKey;
      if (!target) {
        // Unattributable correction: no fact can be replaced, but the case still changed.
        invalidatedGrounded = true;
        continue;
      }
      const previous = facts[target];
      const trimmed = String(value).trim();
      const candidate =
        typeof value === 'number' || typeof value === 'boolean'
          ? value
          : typeof previous === 'number' && /^-?\d+$/.test(trimmed)
            ? Number(trimmed)
            : (interpretPlainAnswer(trimmed)?.value ?? trimmed);
      // B1.0: a correction must ALSO be compatible. An unprovable or unacceptable candidate may
      // not destroy or replace a fact that is already valid.
      if (validateAnswerCompatibility(contractFor(target), candidate) !== 'ACCEPTED') continue;
      writeFact(target, candidate, 'CERTAIN', 'user_answer', trimmed.slice(0, 120));
      // A material fact changed: the previously grounded result is no longer valid.
      // It must not be reusable by a follow-up, and the case is reasoned again.
      invalidatedGrounded = true;
    }

    // 2c. Guarded case state: a grounded result is reusable only while the material facts
    // (value + certainty + provenance) it was derived from are unchanged.
    const currentSignature = caseSignature(facts, meta);
    if (!invalidatedGrounded && session.sessionContext.lastGroundedResult?.caseSignature) {
      if (session.sessionContext.lastGroundedResult.caseSignature !== currentSignature) {
        invalidatedGrounded = true;
        invalidationReason = 'material_fact_changed';
      }
    }
    if (invalidatedGrounded && !invalidationReason) invalidationReason = 'explicit_correction';

    // 3. Context assembly — personal Memory ONLY when policy allows.
    stages.push('CONTEXT_RETRIEVAL');
    if (policy.personalMemoryRead && this.deps.memory) {
      const bounded = await this.deps.memory.fetchBounded(projectId, { subjectId: actor });
      for (const m of bounded.user) {
        const v = (m.payload as Record<string, unknown>).value;
        // Memory is CONTEXT, not a user assertion: same metadata handoff, provenance=memory,
        // certainty UNCERTAIN (never closes a need), and it never overrides a stronger value.
        if (!(m.memoryKey in facts)) writeFact(m.memoryKey, v, 'UNCERTAIN', 'memory');
      }
    }

    // 4. Invoke the skill (K22 readiness gate runs inside the Skills Runtime).
    // The skill receives the turn text plus a BOUNDED recent-turn window (so a
    // skill can read the case as the user described it across turns) — never the
    // full transcript and never the personal Memory store.
    let clarification: { question: string } | undefined;
    const result = await this.deps.skills.execute({
      projectId,
      actor,
      skillId,
      payload: {
        context: facts,
        // Generic candidate facts + bounded fact metadata: the DOMAIN binds and interprets.
        statementFacts: understanding.candidates ?? [],
        pendingKey: session.sessionContext.pendingKey,
        // B3a: only facts whose VALUE actually changed invalidate reuse; an idempotent
        // re-bind of an already-known fact is not a material case change.
        changedFactKeys: writtenKeys.filter((kk) => JSON.stringify(session.sessionContext.facts[kk]) !== JSON.stringify(facts[kk])),
        answeredKeys: writtenKeys.filter((kk) => meta[kk]?.provenance === 'user_answer'),
        correctionsPresent: (understanding.corrections ?? []).length > 0,
        ...(session.sessionContext.skillContext ? { skillContext: session.sessionContext.skillContext } : {}),
        factMeta: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { provenance: v.provenance, certainty: v.certainty }])),
        text: input.text,
        recentTurns: session.sessionContext.recentTurns.slice(-MAX_RECENT_TURNS),
        ...(invalidatedGrounded || !session.sessionContext.lastGroundedResult
          ? {}
          : { lastGroundedResult: session.sessionContext.lastGroundedResult }),
      },
    });
    if (result.readiness) stages.push('CHECKING_READINESS');

    let status: ConversationResponse['status'];
    let message: string;
    let interaction: InteractionSpec | undefined;

    if (result.readiness && result.readiness.status === 'NEEDS_INFORMATION') {
      status = 'needs_information';
      const first = result.readiness.missing.find((m) => m.question) ?? result.readiness.missing[0];
      const hints = this.deps.interactionsFor?.(skillId) ?? {};
      // The requirement's OWN interaction hint wins (a skill that derives its
      // requirements dynamically carries the control with the requirement);
      // the static per-skill hints remain the fallback.
      const hint = first.interaction ?? hints[first.key];
      const type = (hint?.type ?? 'free_text') as InteractionType;
      interaction = {
        type, key: first.key, question: first.question?.wording ?? first.description,
        ...(hint?.options ? { options: hint.options } : {}),
        ...(hint?.allowOther !== undefined ? { allowOther: hint.allowOther } : {}),
        required: true,
      };
      message = interaction.question;
    } else if (result.readiness && result.readiness.status === 'INSUFFICIENT_CONTEXT') {
      status = 'insufficient_context';
      message = 'لا يمكن إكمال السياق المطلوب حالياً.';
    } else if (result.status === 'completed' || result.status === 'needs_clarification') {
      status = result.status === 'completed' ? 'completed' : 'needs_clarification';
      // The skill owns its user-facing answer (a grounded ruling, a source-gap notice,
      // or an explanation). The generic placeholder is only the fallback for a skill
      // that has nothing to say.
      message = result.clarification?.question ?? result.answer?.text ?? 'تمت معالجة طلبك.';
      if (result.clarification?.question) clarification = { question: result.clarification.question };
      if (result.readiness) stages.push('EXECUTING_SKILL');
    } else {
      status = 'failed';
      message = 'تعذر إكمال الطلب.';
    }
    stages.push('PREPARING_RESPONSE');

    // 4b. Facts the skill BOUND to its own need vocabulary: one store, provenance recorded.
    for (const [k, v] of Object.entries(result.caseFacts ?? {})) {
      if (v === undefined || v === null || String(v).trim() === '') continue;
      writeFact(k, v, 'CERTAIN', 'user_statement');
    }

    // 5. Persist bounded session context (bounded recent turns; last question; pending key).
    const grounded = result.trace?.decisionStatus && result.answer
      ? {
          skillId: result.skillId,
          status: String(result.trace.decisionStatus).slice(0, 60),
          ...(result.trace.decisionLabel ? { decision: String(result.trace.decisionLabel).slice(0, 120) } : {}),
          ...(result.answer.text ? { explanation: String(result.answer.text).slice(0, 900) } : {}),
          ...(result.answer.sourceTitle ? { sourceTitle: String(result.answer.sourceTitle).slice(0, 160) } : {}),
          evidenceRefs: (result.answer.evidenceIds ?? result.trace.acceptedEvidenceRefs ?? []).slice(0, 6),
        }
      : undefined;

    const updatedContext: SessionContext = {
      facts,
      // F3: the bounded provenance/certainty metadata travels WITH the facts it describes.
      ...(Object.keys(meta).length > 0 ? { factMeta: Object.fromEntries(Object.entries(meta).slice(-24)) } : {}),
      // A pending question exists only while the turn asked one.
      ...(status === 'needs_information' && interaction ? { pendingKey: interaction.key } : {}),
      // A new grounded result replaces the old one; an invalidating turn clears it;
      // otherwise the existing bounded result is carried forward unchanged.
      ...(grounded
        ? { lastGroundedResult: { ...grounded, caseSignature: currentSignature } }
        : invalidatedGrounded
          ? {}
          : session.sessionContext.lastGroundedResult
            ? { lastGroundedResult: session.sessionContext.lastGroundedResult }
            : {}),
      // B3a: a fresh/refreshed reusable context replaces the old one; a grounded result or an
      // invalidating turn clears it (the follow-up path uses lastGroundedResult, not this).
      ...(result.skillContext && !grounded ? { skillContext: result.skillContext } : {}),
      turnCount: session.sessionContext.turnCount + 1,
      recentTurns: [
        ...session.sessionContext.recentTurns,
        { role: 'user' as const, text: input.text, at: new Date().toISOString() },
        { role: 'assistant' as const, text: message, at: new Date().toISOString() },
      ].slice(-MAX_RECENT_TURNS),
    };
    await this.deps.persistence.save({ ...session, sessionContext: updatedContext, updatedAt: new Date().toISOString() });

    return {
      conversationId: session.id,
      mode: session.mode,
      status,
      understanding: { status: understanding.status, dialogueAct: understanding.dialogueAct },
      ...(result.readiness ? { readiness: { status: result.readiness.status, missingKeys: result.readiness.missing.map((m) => m.key) } } : {}),
      message,
      ...(interaction ? { interaction } : {}),
      stages,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(result.trace ? { trace: result.trace } : {}),
      ...(result.answer ? { answer: result.answer } : {}),
      ...(clarification ? { clarification } : {}),
      caseState: {
        facts: Object.keys(facts).slice(0, 12).map((k) => ({
          key: k,
          value: String(facts[k]).slice(0, 80),
          provenance: meta[k]?.provenance ?? 'user_answer',
          certainty: meta[k]?.certainty ?? 'CERTAIN',
        })),
        ...(status === 'needs_information' && interaction
          ? { pendingNeed: interaction.key }
          : {}),
        groundedResult: grounded ? 'valid' : session.sessionContext.lastGroundedResult && !invalidatedGrounded ? 'valid' : invalidatedGrounded ? 'invalidated' : 'none',
        ...(invalidationReason ? { invalidationReason } : {}),
        candidates: (understanding.candidates ?? []).map((c) => ({ kind: c.kind, value: String(c.value).slice(0, 60), ...(c.unit ? { unit: c.unit } : {}), certainty: c.certainty })),
      },
    };
  }
}

export type { DecisionRequirement };
