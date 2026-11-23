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
  MAX_RECONFIRMATION_KEYS,
  MAX_SESSION_FACTS,
  emptySessionContext,
  policyFor,
  type ConversationMessageInput,
  type ConversationResponse,
  type ConversationSession,
  type ConversationStage,
  type InteractionSpec,
  type LastGroundedResult,
  type SessionContext,
} from './conversation.ts';
import {
  type BoundedUnderstandingContext,
  type MemoryReference,
  type UnderstandingResult,
} from '../understanding/understanding.ts';
import { MAX_SKILL_KEY_LENGTH, type SkillExecutionResult } from '../skill/skill.ts';
import {
  type DecisionRequirement,
  type RequirementInteraction,
} from '../readiness/readiness.ts';
import {
  admitMaterialAnswer,
  admitMaterialCorrection,
  isConfirmedMaterialFact,
  type MaterialAnswerAdmission,
} from '../readiness/material-fact-admission.ts';

export interface ConversationStoragePort {
  create(session: ConversationSession): Promise<ConversationSession>;
  get(projectId: string, actorSubject: string, conversationId: string): Promise<ConversationSession | null>;
  save(session: ConversationSession, expectedUpdatedAt: string): Promise<ConversationSession>;
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

/** Advance the optimistic-lock token even when two turns finish in the same millisecond. */
function nextUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous);
  const nextMs = Number.isFinite(previousMs) ? Math.max(Date.now(), previousMs + 1) : Date.now();
  return new Date(nextMs).toISOString();
}

/** Give equivalent PostgreSQL UUID spellings the same queue identity. */
function queueId(id: string): string {
  const uuid = id.startsWith('{') && id.endsWith('}') ? id.slice(1, -1) : id;
  return /^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(uuid) ? uuid.replaceAll('-', '').toLowerCase() : id;
}

/** Guarded digest of the case state a grounded result may depend on. */
function caseSignature(
  facts: Record<string, unknown>,
  meta: Record<string, { provenance: string; certainty: string }>,
): string {
  const parts = Object.keys(facts)
    .filter((key) => isConfirmedMaterialFact(facts[key], meta[key]) || meta[key]?.provenance === 'evidence')
    .sort()
    .map((key) => `${key}=${JSON.stringify(facts[key])}|${meta[key].certainty}|${meta[key].provenance}`);
  let h = 5381;
  const json = parts.join(';');
  for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(36)}:${json.length}`;
}

import type { CaseFactMeta } from './conversation.ts';
import type { FactCertainty } from '../understanding/understanding.ts';

function admittedGroundingFactKeys(
  value: unknown,
  facts: Readonly<Record<string, unknown>>,
  meta: Readonly<Record<string, { provenance?: string; certainty?: string }>>,
): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) return undefined;
  if (!value.every((key): key is string => typeof key === 'string'
    && key.length <= MAX_SKILL_KEY_LENGTH
    && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))) return undefined;
  if (new Set(value).size !== value.length) return undefined;
  return value.every((key) => Object.hasOwn(facts, key) && isConfirmedMaterialFact(facts[key], meta[key]))
    ? value
    : undefined;
}

function validatedPersistedGroundedResult(
  value: unknown,
  facts: Readonly<Record<string, unknown>>,
  meta: Readonly<Record<string, { provenance?: string; certainty?: string }>>,
): { result: LastGroundedResult; materialFactKeys: string[]; evidenceRefs: string[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.skillId !== 'string' || record.skillId.trim() !== record.skillId
    || record.skillId.length === 0 || record.skillId.length > 120
    || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(record.skillId)) return undefined;
  if (typeof record.status !== 'string' || !['ANSWER', 'DECIDED'].includes(record.status)) return undefined;
  if (typeof record.caseSignature !== 'string' || record.caseSignature.trim() !== record.caseSignature
    || record.caseSignature.length === 0 || record.caseSignature.length > 128) return undefined;
  if (record.decision !== undefined
    && (typeof record.decision !== 'string' || !record.decision.trim() || record.decision.length > 120)) return undefined;
  if (record.explanation !== undefined
    && (typeof record.explanation !== 'string' || !record.explanation.trim() || record.explanation.length > 900)) return undefined;
  if (record.sourceTitle !== undefined
    && (typeof record.sourceTitle !== 'string' || !record.sourceTitle.trim() || record.sourceTitle.length > 160)) return undefined;
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0 || record.evidenceRefs.length > 6
    || !record.evidenceRefs.every((ref): ref is string => typeof ref === 'string'
      && ref.length > 0 && ref.length <= 64 && ref.trim() === ref)) return undefined;
  const materialFactKeys = admittedGroundingFactKeys(record.materialFactKeys, facts, meta);
  if (!materialFactKeys) return undefined;
  return {
    result: record as unknown as LastGroundedResult,
    materialFactKeys,
    evidenceRefs: record.evidenceRefs,
  };
}

const TERMINAL_GROUNDING_REJECTION_STATUSES = new Set([
  'SOURCE_GAP',
  'INSUFFICIENT_EVIDENCE',
  'UNSUPPORTED',
  'NEED_EVIDENCE',
  'ERROR',
]);

/** Classify only trusted, Runtime-lifted terminal fields at the Conversation seam. */
function isTerminalGroundingRejection(result: Pick<SkillExecutionResult, 'trace'>): boolean {
  const trace = result.trace;
  if (!trace) return false;
  return TERMINAL_GROUNDING_REJECTION_STATUSES.has(trace.status ?? '')
    || TERMINAL_GROUNDING_REJECTION_STATUSES.has(trace.decisionStatus ?? '')
    || trace.sourceSupport === 'UNSUPPORTED'
    || ['ANSWER', 'DECIDED'].includes(trace.decisionStatus ?? '');
}

export class ConversationService {
  /**
   * Serialize turns that target the same conversation in this service process. A turn
   * replaces the bounded session_context document, so overlapping read/modify/write
   * cycles would otherwise let the later save erase the earlier turn.
   */
  private readonly turnTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: ConversationDeps) {}

  async create(projectId: string, actor: string, mode: 'contextual' | 'private'): Promise<ConversationSession> {
    const now = new Date().toISOString();
    return this.deps.persistence.create({
      id: crypto.randomUUID(), projectId, actorSubject: actor, mode, status: 'active',
      sessionContext: emptySessionContext(), createdAt: now, updatedAt: now,
    });
  }

  async handleMessage(projectId: string, actor: string, conversationId: string, input: ConversationMessageInput): Promise<ConversationResponse> {
    const turnKey = JSON.stringify([queueId(projectId), actor, queueId(conversationId)]);
    const previous = this.turnTails.get(turnKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    this.turnTails.set(turnKey, current);

    await previous;
    try {
      return await this.handleMessageSerial(projectId, actor, conversationId, input);
    } finally {
      releaseCurrent();
      if (this.turnTails.get(turnKey) === current) this.turnTails.delete(turnKey);
    }
  }

  private async handleMessageSerial(projectId: string, actor: string, conversationId: string, input: ConversationMessageInput): Promise<ConversationResponse> {
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
    const storedReconfirmationKeys = Array.isArray(session.sessionContext.reconfirmation?.keys)
      ? session.sessionContext.reconfirmation.keys.filter((key): key is string =>
        typeof key === 'string' && key.length > 0 && key.length <= MAX_SKILL_KEY_LENGTH)
      : [];
    const reconfirmationKeys = new Set(storedReconfirmationKeys.slice(0, MAX_RECONFIRMATION_KEYS));
    let reconfirmationOverflow = session.sessionContext.reconfirmation?.overflow === true
      || storedReconfirmationKeys.length > MAX_RECONFIRMATION_KEYS;
    // One-way migration from the short-lived round-3 representation. Unknown persisted
    // fields can still be present even after the TypeScript interface changes.
    for (const [key, value] of Object.entries(meta)) {
      const legacy = value as CaseFactMeta & { needsReconfirmation?: true };
      if (legacy.needsReconfirmation === true) reconfirmationKeys.add(key);
      delete legacy.needsReconfirmation;
    }
    const requireReconfirmation = (key: string): void => {
      if (reconfirmationKeys.has(key)) return;
      if (reconfirmationKeys.size < MAX_RECONFIRMATION_KEYS) reconfirmationKeys.add(key);
      else reconfirmationOverflow = true;
    };
    const factStatus = (key: string): Pick<CaseFactMeta, 'certainty' | 'provenance'> => ({
      certainty: meta[key]?.certainty ?? 'UNCERTAIN',
      provenance: meta[key]?.provenance ?? 'user_statement',
    });
    const nowIso = new Date().toISOString();
    // EXPLICIT precedence (lowest → highest): memory < user_statement < user_answer.
    // A current user input is never silently overridden by Memory.
    const RANK: Record<string, number> = { memory: 0, evidence: 1, user_statement: 2, user_answer: 3 };
    const writtenKeys: string[] = [];
    const answeredKeys = new Set<string>();
    const confirmedKeys = new Set<string>();
    const canWriteAnswer = (key: string): boolean => answeredKeys.has(key) || answeredKeys.size < MAX_SESSION_FACTS;
    const writeFact = (
      key: string,
      value: unknown,
      certainty: FactCertainty,
      provenance: CaseFactMeta['provenance'],
      original?: string,
      origin?: 'app',
      admission?: CaseFactMeta['admission'],
    ): void => {
      writtenKeys.push(String(key));
      const prev = meta[key];
      if (prev && RANK[prev.provenance] > RANK[provenance] && prev.certainty === 'CERTAIN') return; // never downgrade a stronger current value
      const superseded = Object.hasOwn(facts, key) && facts[key] !== value
        ? [...(prev?.superseded ?? []), { value: String(facts[key]).slice(0, 120), at: prev?.at ?? session.updatedAt }].slice(-2)
        : prev?.superseded;
      facts[key] = value;
      meta[key] = { provenance, certainty, at: nowIso, ...(original ? { original } : {}), ...(superseded ? { superseded } : {}), ...(origin ? { origin } : {}), ...(admission ? { admission } : {}) };
    };
    // B1.0 — ONE canonical expected-answer contract per pending/answered need. The persisted
    // requirement (B3a turn context) wins; the skill's static interaction hints are the fallback.
    // A need with no trustworthy contract can never be fast-bound: the candidate is not provable.
    const skillId = input.skillId ?? this.deps.defaultSkillId;
    const storedPendingKey = session.sessionContext.pendingKey;
    const pendingInteraction = session.sessionContext.pendingInteraction;
    const pendingTrust = session.sessionContext.pendingInteractionTrust;
    const declaredPendingKey = pendingTrust?.declared === true && pendingInteraction ? storedPendingKey : undefined;
    const pendingKey = pendingTrust?.skillId === skillId ? declaredPendingKey : undefined;
    const storedSkillContext = session.sessionContext.skillContext;
    const skillContext = storedSkillContext?.skillId === skillId ? storedSkillContext : undefined;
    const hints = this.deps.interactionsFor?.(skillId) ?? {};
    const admittedContract = (key: string): RequirementInteraction | undefined => {
      const admission = meta[key]?.admission;
      return admission?.skillId === skillId ? admission.interaction : undefined;
    };
    const contractFor = (key: string): RequirementInteraction | undefined =>
      (key === pendingKey ? pendingInteraction : undefined) ??
      admittedContract(key) ??
      skillContext?.requirements.find((r) => r.key === key)?.interaction ??
      (Object.hasOwn(hints, key) ? hints[key] : undefined);

    /**
     * Bind ONLY a candidate proven compatible with the requirement's contract.
     * REJECTED is inert: nothing is written and the key is never counted as answered (an
     * invalid candidate can neither create nor overwrite a fact). UNKNOWN keeps the answer as
     * NON-certain, so it never closes a need and never becomes invented certainty.
     */
    const writeAnswer = (key: string, admission: Exclude<MaterialAnswerAdmission, { outcome: 'ignored' }>, interaction?: RequirementInteraction, original?: string): void => {
      const contract = interaction ? { skillId, interaction: structuredClone(interaction) } : undefined;
      writeFact(key, admission.value, admission.certainty, 'user_answer', original, undefined, contract);
      // An explicit admitted answer (including an explicit UNKNOWN withdrawal) resolves
      // only this fact's reconfirmation requirement.
      reconfirmationKeys.delete(key);
      answeredKeys.add(key);
      if (admission.outcome === 'accepted') confirmedKeys.add(key);
      else confirmedKeys.delete(key);
    };
    const admitAnswer = (key: string, source: 'structured' | 'raw', value: unknown, original?: string): void => {
      if (!canWriteAnswer(key)) return;
      const interaction = contractFor(key);
      const allowWithdrawal = !interaction && isConfirmedMaterialFact(facts[key], meta[key]);
      const admission = admitMaterialAnswer({ interaction, source, value, allowWithdrawal });
      if (admission.outcome !== 'ignored') writeAnswer(key, admission, interaction, original);
    };

    if (Array.isArray(input.answers)) {
      for (const a of input.answers) {
        if (a && typeof a.key === 'string') {
          admitAnswer(a.key, 'structured', a.value);
        }
      }
    }

    // 2. Understanding (K19) — with bounded session context.
    stages.push('UNDERSTANDING');
    const understanding = await this.deps.understanding.evaluate({ projectId, text: input.text, context: factsToContext(facts) });
    const candidates = (understanding.candidates ?? []).map((candidate) => ({
      ...candidate,
      certainty: candidate.certainty === 'UNKNOWN' ? 'UNKNOWN' as const : 'UNCERTAIN' as const,
    }));
    if (!Array.isArray(input.answers) && pendingKey) {
      admitAnswer(pendingKey, 'raw', input.text, input.text.trim().slice(0, 120));
    }

    const correctionContractsFor = (key: string): readonly RequirementInteraction[] => {
      // The active interaction is the current contract for this key. Historical
      // admissions must not weaken or reinterpret it.
      if (key === declaredPendingKey && pendingInteraction) return [pendingInteraction];
      const contracts = [contractFor(key), meta[key]?.admission?.interaction].filter(
        (interaction): interaction is RequirementInteraction => interaction !== undefined,
      );
      return contracts.filter((interaction, index) =>
        contracts.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(interaction)) === index);
    };
    const canCorrect = (key: string): boolean => key !== declaredPendingKey || key === pendingKey;
    const confirmedFacts = Object.fromEntries(Object.entries(facts).filter(([key, value]) => isConfirmedMaterialFact(value, meta[key])));
    const correction = admitMaterialCorrection({
      text: input.text, proposals: understanding.corrections, facts: confirmedFacts, pendingKey: declaredPendingKey,
      contractFor: (key) => canCorrect(key) ? contractFor(key) : undefined,
      contractsFor: correctionContractsFor,
      canCorrectLegacyFact: (key) => canCorrect(key) && !meta[key]?.admission && isConfirmedMaterialFact(facts[key], meta[key]),
    });
    const correctionOpen = correction !== undefined && !answeredKeys.has(correction.key) && canWriteAnswer(correction.key);
    const correctionApplied = correctionOpen && correction.outcome === 'accepted';
    const correctionBlocked = correctionOpen && correction.outcome === 'unproven_contract';
    if (correctionApplied) {
      writeAnswer(correction.key, { outcome: 'accepted', value: correction.value, certainty: 'CERTAIN' },
        correction.interaction, input.text.trim().slice(0, 120));
    } else if (correctionBlocked) {
      writeFact(correction.key, facts[correction.key], 'UNCERTAIN', 'user_answer', input.text.trim().slice(0, 120));
      requireReconfirmation(correction.key);
      answeredKeys.add(correction.key);
    }
    let invalidatedGrounded = correctionApplied || correctionBlocked;
    let invalidationReason: string | undefined = correctionBlocked ? 'correction_contract_unproven' : undefined;

    // 3. Assemble contextual app evidence only after user-answer admission. An appContext
    // object replaces the previous app snapshot. User, Memory and legacy facts are protected.
    if (session.mode !== 'private' && input.appContext && typeof input.appContext === 'object') {
      const isAppOrigin = (m: CaseFactMeta | undefined): boolean => m?.origin === 'app' || m?.provenance === 'evidence';
      const snapshotKeys = new Set<string>();
      const entries = Object.entries(input.appContext).slice(0, MAX_SESSION_FACTS);
      for (const [k, v] of entries) {
        if (typeof k !== 'string' || !k.trim()) continue;
        if (v === undefined || v === null || String(v).trim?.() === '') continue;
        const key = k.trim().slice(0, 60);
        snapshotKeys.add(key);
        if (key in facts) {
          if (!isAppOrigin(meta[key])) continue;
          if (JSON.stringify(facts[key]) === JSON.stringify(v)) continue;
        }
        writeFact(key, v, 'UNCERTAIN', 'evidence', undefined, 'app');
      }
      for (const key of Object.keys(facts)) {
        if (snapshotKeys.has(key) || !isAppOrigin(meta[key])) continue;
        delete facts[key];
        delete meta[key];
        writtenKeys.push(key);
      }
    }

    // Keep each retained fact and its metadata together at the same bound. Explicit
    // user answers have priority over app evidence, legacy state, and Memory.
    const factKeys = Object.keys(facts);
    if (factKeys.length > MAX_SESSION_FACTS) {
      const rank = (key: string): number => {
        switch (meta[key]?.provenance) {
          case 'user_answer': return 3;
          case 'evidence': return 2;
          case 'memory': return 0;
          default: return 1;
        }
      };
      const certaintyRank = (key: string): number => meta[key]?.certainty === 'CERTAIN' ? 2 : meta[key]?.certainty === 'UNKNOWN' ? 1 : 0;
      factKeys.sort((a, b) => Number(answeredKeys.has(b)) - Number(answeredKeys.has(a))
        || rank(b) - rank(a)
        || certaintyRank(b) - certaintyRank(a)
        || (meta[b]?.at ?? '').localeCompare(meta[a]?.at ?? '')
        || a.localeCompare(b));
      for (const key of factKeys.slice(MAX_SESSION_FACTS)) {
        delete facts[key];
        delete meta[key];
        confirmedKeys.delete(key);
        writtenKeys.push(key);
      }
    }

    // Guard reuse against changes to confirmed answers and the current app snapshot.
    const currentSignature = caseSignature(facts, meta);
    const rawPreviousGrounded = session.sessionContext.lastGroundedResult as unknown;
    const hasPersistedGroundedResult = Object.hasOwn(session.sessionContext, 'lastGroundedResult')
      && rawPreviousGrounded !== undefined;
    const validatedPreviousGrounded = validatedPersistedGroundedResult(rawPreviousGrounded, facts, meta);
    const previousGrounded = validatedPreviousGrounded?.result;
    const unresolvedCorrection = reconfirmationKeys.size > 0 || reconfirmationOverflow;
    const previousGroundingProof = validatedPreviousGrounded?.materialFactKeys;
    const previousEvidenceRefs = validatedPreviousGrounded?.evidenceRefs;
    if (!invalidatedGrounded && hasPersistedGroundedResult && !validatedPreviousGrounded) {
      invalidatedGrounded = true;
      invalidationReason = 'grounded_dependency_proof_missing_or_invalid';
    } else if (!invalidatedGrounded && previousGrounded && unresolvedCorrection) {
      invalidatedGrounded = true;
      invalidationReason = 'correction_contract_unproven';
    } else if (!invalidatedGrounded && previousGrounded && previousGrounded.caseSignature !== currentSignature) {
      invalidatedGrounded = true;
      const signature = previousGrounded.caseSignature;
      invalidationReason = typeof signature === 'string' && signature.trim() ? 'material_fact_changed' : 'unsigned_grounded_result';
    }
    if (invalidatedGrounded && !invalidationReason) invalidationReason = 'explicit_correction';

    // Personal Memory is read only when policy allows.
    stages.push('CONTEXT_RETRIEVAL');
    if (policy.personalMemoryRead && this.deps.memory) {
      const bounded = await this.deps.memory.fetchBounded(projectId, { subjectId: actor });
      let capacity = MAX_SESSION_FACTS - Object.keys(facts).length;
      for (const m of bounded.user) {
        if (capacity === 0) break;
        const v = (m.payload as Record<string, unknown>).value;
        // Memory is CONTEXT, not a user assertion: same metadata handoff, provenance=memory,
        // certainty UNCERTAIN (never closes a need), and it never overrides a stronger value.
        if (!(m.memoryKey in facts)) {
          writeFact(m.memoryKey, v, 'UNCERTAIN', 'memory');
          capacity -= 1;
        }
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
        // Understanding observations can guide the domain's next question, but they are
        // never authorization to satisfy a material need or publish a personal ruling.
        statementFacts: candidates,
        pendingKey,
        // B3a: only facts whose VALUE actually changed invalidate reuse; an idempotent
        // re-bind of an already-known fact is not a material case change.
        changedFactKeys: writtenKeys.filter((kk) => JSON.stringify(session.sessionContext.facts[kk]) !== JSON.stringify(facts[kk])),
        answeredKeys: [...confirmedKeys],
        correctionsPresent: correctionApplied || correctionBlocked,
        ...(skillContext ? { skillContext } : {}),
        factMeta: Object.fromEntries(Object.keys(facts).map((key) => [key, factStatus(key)])),
        text: input.text,
        recentTurns: session.sessionContext.recentTurns.slice(-MAX_RECENT_TURNS),
        ...(invalidatedGrounded || !previousGrounded
          ? {}
          : { lastGroundedResult: previousGrounded }),
      },
    });
    if (result.readiness) stages.push('CHECKING_READINESS');
    const decisionStatus = result.trace?.decisionStatus;
    const suspendedDecision = unresolvedCorrection && !!(
      result.answer?.label || decisionStatus === 'DECIDED' || decisionStatus === 'ANSWER'
    );

    let status: ConversationResponse['status'];
    let message: string;
    let interaction: InteractionSpec | undefined;
    let pendingContract: RequirementInteraction | undefined;

    if (suspendedDecision) {
      status = 'insufficient_context';
      message = 'لا يمكن إكمال السياق المطلوب حالياً.';
    } else if (result.readiness && result.readiness.status === 'NEEDS_INFORMATION') {
      status = 'needs_information';
      const first = result.readiness.missing.find((m) => m.question) ?? result.readiness.missing[0];
      // The requirement's OWN interaction hint wins (a skill that derives its
      // requirements dynamically carries the control with the requirement);
      // the static per-skill hints remain the fallback.
      pendingContract = first.interaction ?? (Object.hasOwn(hints, first.key) ? hints[first.key] : undefined);
      interaction = {
        type: pendingContract?.type ?? 'free_text', key: first.key, question: first.question?.wording ?? first.description,
        ...(pendingContract?.options ? { options: pendingContract.options } : {}),
        ...(pendingContract?.allowOther !== undefined ? { allowOther: pendingContract.allowOther } : {}),
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

    // 5. Persist bounded session context (bounded recent turns; last question; pending key).
    const groundedFactKeys = admittedGroundingFactKeys(result.trace?.materialFactKeys, facts, meta);
    const groundedEvidenceRefs = (result.answer?.evidenceIds ?? result.trace?.acceptedEvidenceRefs ?? []).slice(0, 6);
    const reusedGroundedResult = !suspendedDecision
      && result.trace?.reusedGroundedResult === true
      && ['FOLLOWUP_SOURCE', 'FOLLOWUP_WHY'].includes(result.trace.status ?? '')
      && previousGrounded !== undefined
      && previousGroundingProof !== undefined
      && result.skillId === previousGrounded.skillId
      && result.trace?.decisionStatus === previousGrounded.status
      && result.trace?.sourceSupport === 'SUPPORTED'
      && result.trace?.decisionLabel === previousGrounded.decision
      && groundedFactKeys !== undefined
      && groundedFactKeys.length === previousGroundingProof.length
      && groundedFactKeys.every((key, index) => key === previousGroundingProof[index])
      && previousEvidenceRefs !== undefined
      && groundedEvidenceRefs.length === previousEvidenceRefs.length
      && groundedEvidenceRefs.every((ref, index) => ref === previousEvidenceRefs[index]);
    const grounded = !reusedGroundedResult && !suspendedDecision && result.answer
      && ['ANSWER', 'DECIDED'].includes(result.trace?.decisionStatus ?? '')
      && result.trace?.sourceSupport === 'SUPPORTED'
      && groundedEvidenceRefs.length > 0
      && groundedFactKeys
      ? {
          skillId: result.skillId,
          status: String(result.trace.decisionStatus).slice(0, 60),
          ...(result.trace.decisionLabel ? { decision: String(result.trace.decisionLabel).slice(0, 120) } : {}),
          ...(result.answer.text ? { explanation: String(result.answer.text).slice(0, 900) } : {}),
          ...(result.answer.sourceTitle ? { sourceTitle: String(result.answer.sourceTitle).slice(0, 160) } : {}),
          evidenceRefs: groundedEvidenceRefs,
          materialFactKeys: groundedFactKeys,
        }
      : undefined;
    const terminalGroundingRejected = !reusedGroundedResult && !grounded && !suspendedDecision
      && isTerminalGroundingRejection(result);
    if (!invalidatedGrounded && previousGrounded && terminalGroundingRejected) {
      invalidatedGrounded = true;
      invalidationReason = 'terminal_result_not_grounded';
    }

    const persistedMeta = Object.fromEntries(Object.entries(meta).filter(([key]) => Object.hasOwn(facts, key)));
    const updatedContext: SessionContext = {
      facts,
      // F3: the bounded provenance/certainty metadata travels WITH the facts it describes.
      ...(Object.keys(persistedMeta).length > 0 ? { factMeta: persistedMeta } : {}),
      ...(reconfirmationKeys.size > 0 || reconfirmationOverflow ? {
        reconfirmation: {
          keys: [...reconfirmationKeys].slice(0, MAX_RECONFIRMATION_KEYS),
          ...(reconfirmationOverflow ? { overflow: true as const } : {}),
        },
      } : {}),
      // A new material question replaces the pending one. An unrelated question
      // does not answer the old need; retain its contract across that interruption.
      ...(status === 'needs_information' && interaction
        ? { pendingKey: interaction.key, ...(pendingContract ? {
            pendingInteraction: structuredClone(pendingContract), pendingInteractionTrust: { skillId, declared: true as const },
          } : {}) }
        : storedPendingKey && !confirmedKeys.has(storedPendingKey)
          && !grounded && result.readiness?.status !== 'READY_FOR_DECISION'
          ? { pendingKey: storedPendingKey, pendingInteraction, pendingInteractionTrust: pendingTrust }
          : {}),
      // A new grounded result replaces the old one; an invalidating turn clears it;
      // otherwise the existing bounded result is carried forward unchanged.
      ...(grounded
        ? { lastGroundedResult: { ...grounded, caseSignature: caseSignature(facts, persistedMeta) } }
        : invalidatedGrounded
          ? {}
          : previousGrounded
            ? { lastGroundedResult: previousGrounded }
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
    await this.deps.persistence.save(
      { ...session, sessionContext: updatedContext, updatedAt: nextUpdatedAt(session.updatedAt) },
      session.updatedAt,
    );

    return {
      conversationId: session.id,
      mode: session.mode,
      status,
      understanding: { status: understanding.status, dialogueAct: understanding.dialogueAct },
      ...(!suspendedDecision && result.readiness ? { readiness: { status: result.readiness.status, missingKeys: result.readiness.missing.map((m) => m.key) } } : {}),
      message,
      ...(interaction ? { interaction } : {}),
      stages,
      ...(result.runId ? { runId: result.runId } : {}),
      ...(!suspendedDecision && result.trace ? { trace: result.trace } : {}),
      ...(!suspendedDecision && result.answer ? { answer: result.answer } : {}),
      ...(clarification ? { clarification } : {}),
      caseState: {
        facts: Object.keys(facts).slice(0, 12).map((k) => ({
          key: k,
          value: String(facts[k]).slice(0, 80),
          ...factStatus(k),
        })),
        ...(status === 'needs_information' && interaction
          ? { pendingNeed: interaction.key }
          : {}),
        groundedResult: grounded ? 'valid' : previousGrounded && !invalidatedGrounded ? 'valid' : invalidatedGrounded ? 'invalidated' : 'none',
        ...(invalidationReason ? { invalidationReason } : {}),
        candidates: candidates.map((c) => ({ kind: c.kind, value: String(c.value).slice(0, 60), ...(c.unit ? { unit: c.unit } : {}), certainty: c.certainty })),
      },
    };
  }
}

export type { DecisionRequirement };
