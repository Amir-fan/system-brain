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
import type { DecisionRequirement } from '../readiness/readiness.ts';

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
  interactionsFor?: (skillId: string) => Record<string, { type: InteractionType; options?: string[]; allowOther?: boolean }>;
}

function factsToContext(facts: Record<string, unknown>): BoundedUnderstandingContext {
  const conversation: MemoryReference[] = Object.entries(facts).map(([key, value]) => ({
    id: 'session:' + key, scope: 'conversation', memoryType: 'session', memoryKey: key, payload: { value },
  }));
  return { user: [], conversation, case: [] };
}

/** Does the raw text look like a plain value for the pending requirement? */
function parsePlainValue(text: string): unknown | undefined {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (/^(نعم|yes|صحيح)$/i.test(t)) return true;
  if (/^(لا|no)$/i.test(t)) return false;
  return undefined;
}

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
    if (Array.isArray(input.answers)) {
      for (const a of input.answers) if (a && typeof a.key === 'string') facts[a.key] = a.value;
    } else if (session.sessionContext.pendingKey) {
      const parsed = parsePlainValue(input.text); // manual/free-text fallback
      if (parsed !== undefined) facts[session.sessionContext.pendingKey] = parsed;
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
    for (const correction of understanding.corrections) {
      const value = correction.new;
      if (value === undefined || value === null || String(value).trim() === '') continue;
      // A correction means the case changed: any previously grounded result is stale,
      // even when the fact itself cannot be attributed to a known requirement key.
      invalidatedGrounded = true;
      const target =
        correction.target && Object.prototype.hasOwnProperty.call(facts, correction.target)
          ? correction.target
          : session.sessionContext.pendingKey;
      if (!target) continue;
      const previous = facts[target];
      const trimmed = String(value).trim();
      facts[target] = typeof previous === 'number' && /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
      // A material fact changed: the previously grounded result is no longer valid.
      // It must not be reusable by a follow-up, and the case is reasoned again.
      invalidatedGrounded = true;
    }

    // 3. Context assembly — personal Memory ONLY when policy allows.
    stages.push('CONTEXT_RETRIEVAL');
    if (policy.personalMemoryRead && this.deps.memory) {
      const bounded = await this.deps.memory.fetchBounded(projectId, { subjectId: actor });
      for (const m of bounded.user) {
        const v = (m.payload as Record<string, unknown>).value;
        if (!(m.memoryKey in facts)) facts[m.memoryKey] = v; // known context prevents duplicate questions
      }
    }

    // 4. Invoke the skill (K22 readiness gate runs inside the Skills Runtime).
    // The skill receives the turn text plus a BOUNDED recent-turn window (so a
    // skill can read the case as the user described it across turns) — never the
    // full transcript and never the personal Memory store.
    const skillId = input.skillId ?? this.deps.defaultSkillId;
    const result = await this.deps.skills.execute({
      projectId,
      actor,
      skillId,
      payload: {
        context: facts,
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
      message = result.answer?.text ?? 'تمت معالجة طلبك.';
      if (result.readiness) stages.push('EXECUTING_SKILL');
    } else {
      status = 'failed';
      message = 'تعذر إكمال الطلب.';
    }
    stages.push('PREPARING_RESPONSE');

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
      ...(status === 'needs_information' && interaction ? { pendingKey: interaction.key } : {}),
      // A new grounded result replaces the old one; an invalidating turn clears it;
      // otherwise the existing bounded result is carried forward unchanged.
      ...(grounded
        ? { lastGroundedResult: grounded }
        : invalidatedGrounded
          ? {}
          : session.sessionContext.lastGroundedResult
            ? { lastGroundedResult: session.sessionContext.lastGroundedResult }
            : {}),
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
    };
  }
}

export type { DecisionRequirement };
