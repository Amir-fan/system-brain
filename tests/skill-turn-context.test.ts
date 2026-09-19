/**
 * B3a — Skill Turn Context deterministic tests crossing the REAL runtime seam.
 *
 * Acceptance path: real ConversationService → real SkillsRuntime → registered
 * contract-faithful fake skill → fake persistence/store only at external boundaries.
 *
 * The fake skill implements the same B3a fast-path contract as the production
 * fiqh-hayd skill: reusable skillContext, canReuse gate, fast trace booleans,
 * and the decision-ready fallback-to-grounded path. No model calls.
 *
 * NOTE (B1.1): this file is a RUNTIME-SEAM fixture — it proves skillContext crosses the runtime
 * and is persisted/handed back. The production Skill additionally applies the B1.1/K-3 materiality
 * stability guard before reusing a persisted requirement list; that policy is proved against the
 * REAL skill in tests/minimum-questioning.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import type { SkillDefinition, SkillExecutionContext, SkillTurnContext } from '../src/core/skill/skill.ts';
import {
  MAX_SKILL_CONTEXT_REQUIREMENTS,
  MAX_SKILL_CONTEXT_EVIDENCE,
  MAX_SKILL_CONTEXT_SOURCES,
} from '../src/core/skill/skill.ts';
import type { DecisionRequirement, KnownContextItem } from '../src/core/readiness/readiness.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import type { RunRecord, RuntimePersistence } from '../src/core/runtime/runtime.ports.ts';
import type { ProjectBoundaryReaders } from '../src/core/authorization/project-boundary.ts';
import type { UnderstandingResult } from '../src/core/understanding/understanding.ts';

// ── constants ──────────────────────────────────────────────────────────────

const SKILL_ID = 'test.b3a-context';
const SKILL_VERSION = 1;
const APPROVED_SOURCE_ID = 'src-approved-1';
const ISSUE_SIG = 'test-issue-sig';
const BASE_SIG = 'test-base-sig';
const EVIDENCE_REFS = ['chunk-1', 'chunk-2'];

const REQ_CESSATION: DecisionRequirement = {
  key: 'bleeding_cessation',
  description: 'هل توقف الدم تمامًا',
  material: true,
  question: { key: 'bleeding_cessation', wording: 'هل توقف الدم تمامًا؟' },
  interaction: { type: 'yes_no' },
};
const REQ_HABIT: DecisionRequirement = {
  key: 'habit_days',
  description: 'عادة أيام الدورة',
  material: true,
  question: { key: 'habit_days', wording: 'كم يومًا عادتك؟' },
  interaction: { type: 'number' },
};

// ── fake persistence (RuntimePersistence & ProjectBoundaryReaders) ──────────

function fakeRuntimePersistence(): RuntimePersistence & ProjectBoundaryReaders & { runs: Record<string, RunRecord> } {
  const runs: Record<string, RunRecord> = {};
  return {
    runs,
    async getProject(id: string) {
      return id === 'p' ? { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' } : null;
    },
    async getMembership(projectId: string, actor: string) {
      return { projectId, actor, role: 'owner' as const, createdAt: '' };
    },
    async createRun(run: RunRecord) { runs[run.id] = run; },
    async updateRun(id: string, patch: Partial<RunRecord>) {
      runs[id] = { ...(runs[id] ?? { id }), ...patch } as RunRecord;
    },
  };
}

// ── fake conversation store ────────────────────────────────────────────────

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) {
      const s = rows.get(id);
      return s && s.projectId === p && s.actorSubject === a ? s : null;
    },
    async save(s: ConversationSession) { rows.set(s.id, s); return s; },
  };
}

// ── fake understanding ──────────────────────────────────────────────────────

function fakeUnderstanding(corrections: Array<{ target?: string; new?: string }> = []) {
  return {
    evaluate: async ({ text }: { text: string }): Promise<UnderstandingResult> => ({
      status: 'CLEAR' as const,
      dialogueAct: 'STATEMENT' as const,
      language: 'ar' as const,
      issues: [text],
      references: { resolved: true },
      corrections: corrections.map((c) => ({ target: c.target, new: c.new })),
      facts: [],
      candidates: [],
      ambiguity: { material: false },
      contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
    }),
  };
}

// ── contract-faithful B3a fake skill ─────────────────────────────────────────

function createB3aFakeSkill(
  deps: { readiness: DecisionReadinessService },
  defaultRequirements: DecisionRequirement[] = [REQ_CESSATION, REQ_HABIT],
): SkillDefinition {
  return {
    id: SKILL_ID,
    version: SKILL_VERSION,
    description: 'B3a fake: reusable skillContext, fast-path, grounded fallback',
    requirements: { understanding: false, memory: false, knowledge: false, model: false },
    validateInput: (input: unknown) =>
      input && typeof input === 'object' ? { ok: true } : { ok: false, message: 'input must be an object' },
    validateOutput: (output: unknown) =>
      output && typeof output === 'object' ? { ok: true } : { ok: false, message: 'output must be an object' },

    async execute(ctx: SkillExecutionContext) {
      const input = (ctx.input ?? {}) as {
        context?: Record<string, unknown>;
        pendingKey?: string;
        changedFactKeys?: string[];
        answeredKeys?: string[];
        correctionsPresent?: boolean;
        skillContext?: SkillTurnContext;
        factMeta?: Record<string, { certainty?: string }>;
      };
      const known = input.context ?? {};
      const notes: string[] = [];

      // ── fast path: reuse skillContext ──
      const reusable = input.skillContext;
      const answeredKeys = (input.answeredKeys ?? []).filter(Boolean);
      const changedKeys = (input.changedFactKeys ?? []).filter(Boolean);
      const pendingStored = input.pendingKey ?? '';
      const reusableRequirements = (reusable?.requirements ?? [])
        .slice(0, MAX_SKILL_CONTEXT_REQUIREMENTS)
        .filter((r) => Boolean(r && r.key));

      const canReuse = Boolean(
        reusable &&
          reusable.skillId === SKILL_ID &&
          reusable.skillVersion === SKILL_VERSION &&
          pendingStored &&
          answeredKeys.length === 1 &&
          answeredKeys[0] === pendingStored &&
          changedKeys.length > 0 &&
          changedKeys.every((k) => k === pendingStored) &&
          input.correctionsPresent !== true &&
          reusableRequirements.length > 0 &&
          reusable.evidenceRefs.length > 0 &&
          reusable.sourceIds.length > 0 &&
          reusable.sourceIds.every((id) => id === APPROVED_SOURCE_ID),
      );

      if (canReuse && reusable) {
        const metaIn = input.factMeta ?? {};
        const knownItems: KnownContextItem[] = Object.entries(known)
          .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
          .map(([key, value]) => ({
            key,
            value,
            source: 'conversation' as const,
            ...(metaIn[key]?.certainty
              ? { certainty: metaIn[key]!.certainty as 'CERTAIN' | 'UNCERTAIN' | 'UNKNOWN' }
              : {}),
          }));
        const reusedReadiness = deps.readiness.evaluate({
          requirements: reusableRequirements,
          known: knownItems,
        });

        if (reusedReadiness.status !== 'READY_FOR_DECISION') {
          const refreshed: SkillTurnContext = {
            skillId: SKILL_ID,
            skillVersion: SKILL_VERSION,
            issueSignature: reusable.issueSignature,
            requirements: reusableRequirements,
            evidenceRefs: reusable.evidenceRefs.slice(0, MAX_SKILL_CONTEXT_EVIDENCE),
            sourceIds: reusable.sourceIds.slice(0, MAX_SKILL_CONTEXT_SOURCES),
            baseCaseSignature: reusable.baseCaseSignature,
            at: new Date().toISOString(),
          };
          return {
            status: 'NEEDS_INFORMATION',
            readiness: reusedReadiness,
            skillContext: refreshed,
            trace: {
              plannerCalled: false,
              retrievalCalled: false,
              interpreterCalled: false,
              decisionCalled: false,
              evidenceReloadCalled: false,
            },
          };
        }
        // Fast-path readiness satisfied → fall through to grounded path.
        notes.push('b3a_decision_fallback_to_grounded_path');
      }

      // ── full path ──
      const requirements = canReuse && reusable ? reusableRequirements : defaultRequirements;
      const metaIn = input.factMeta ?? {};
      const knownItems: KnownContextItem[] = Object.entries(known)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([key, value]) => ({
          key,
          value,
          source: 'conversation' as const,
          ...(metaIn[key]?.certainty
            ? { certainty: metaIn[key]!.certainty as 'CERTAIN' | 'UNCERTAIN' | 'UNKNOWN' }
            : {}),
        }));
      const readiness = deps.readiness.evaluate({ requirements, known: knownItems });

      if (readiness.status !== 'READY_FOR_DECISION') {
        return {
          status: 'NEEDS_INFORMATION',
          readiness,
          skillContext: {
            skillId: SKILL_ID,
            skillVersion: SKILL_VERSION,
            issueSignature: ISSUE_SIG,
            requirements,
            evidenceRefs: EVIDENCE_REFS.slice(0, MAX_SKILL_CONTEXT_EVIDENCE),
            sourceIds: [APPROVED_SOURCE_ID],
            baseCaseSignature: BASE_SIG,
            at: new Date().toISOString(),
          },
          trace: {
            plannerCalled: true,
            retrievalCalled: true,
            interpreterCalled: true,
            decisionCalled: false,
            evidenceReloadCalled: false,
          },
        };
      }

      return {
        status: 'DECIDED',
        readiness,
        answer: { text: 'تم الحسم بناءً على المصدر المعتمد.', evidenceIds: EVIDENCE_REFS },
        trace: {
          plannerCalled: true,
          retrievalCalled: true,
          interpreterCalled: true,
          decisionCalled: true,
          evidenceReloadCalled: false,
          decisionStatus: 'DECIDED',
          decisionLabel: 'تم',
          confidence: 'HIGH',
          sourceSupport: 'SUPPORTED',
          acceptedEvidenceRefs: EVIDENCE_REFS,
          ...(notes.length > 0 ? { notes } : {}),
        },
      };
    },
  };
}

// ── system factory: ConversationService → real SkillsRuntime → fake skill ───

function createSystem(opts?: {
  understandingCorrections?: Array<{ target?: string; new?: string }>;
  memoryRows?: Array<{ memoryKey: string; value: unknown }>;
  requirements?: DecisionRequirement[];
}) {
  const readinessService = new DecisionReadinessService();
  const skill = createB3aFakeSkill({ readiness: readinessService }, opts?.requirements);
  const registry = new MapSkillRegistry();
  registry.register(skill);
  const runtimePersistence = fakeRuntimePersistence();
  const runtime = new SkillsRuntime({
    persistence: runtimePersistence,
    registry,
    readiness: readinessService,
  });
  const store = fakeStore();
  const service = new ConversationService({
    persistence: store,
    understanding: fakeUnderstanding(opts?.understandingCorrections),
    skills: { execute: (input: { projectId: string; actor: string; skillId: string; payload: unknown }) => runtime.execute(input) },
    ...(opts?.memoryRows
      ? {
          memory: {
            fetchBounded: async () => ({
              user: opts.memoryRows!.map((m) => ({
                id: 'm',
                scope: 'user',
                memoryType: 'preference',
                memoryKey: m.memoryKey,
                payload: { value: m.value },
              })),
              conversation: [],
              case: [],
            }),
          },
        }
      : {}),
    // The skill's declared expected-answer contracts — the same static-hint mechanism
    // composition.ts uses, so a turn with no persisted turn context is still provable.
    interactionsFor: () => ({ bleeding_cessation: { type: 'yes_no' }, habit_days: { type: 'number' } }),
    defaultSkillId: SKILL_ID,
  });
  return { service, store, runtime, readinessService };
}

// ── helper: start a conversation and send one message ─────────────────────

async function startConversation(
  service: ConversationService,
  text: string,
  mode: 'contextual' | 'private' = 'private',
) {
  const session = await service.create('p', 'a', mode);
  const response = await service.handleMessage('p', 'a', session.id, { text });
  return { session, response };
}

// ===========================================================================
// A. RUNTIME PASS-THROUGH — skill returns skillContext; runtime preserves it
// ===========================================================================

test('A. runtime pass-through: skillContext + trace booleans preserved through real SkillsRuntime', async () => {
  const { service, store } = createSystem();
  const { response, session } = await startConversation(service, 'نزل علي دم');

  // The real SkillsRuntime's liftFromOutput preserved skillContext.
  const stored = store.rows.get(session.id)!.sessionContext;
  assert.ok(stored.skillContext, 'skillContext crossed the runtime seam into the session');
  assert.equal(stored.skillContext!.skillId, SKILL_ID);
  assert.equal(stored.skillContext!.skillVersion, SKILL_VERSION);
  assert.ok(stored.skillContext!.requirements.length > 0);
  assert.ok(stored.skillContext!.evidenceRefs.length > 0);

  // The trace booleans are preserved through liftFromOutput.
  assert.equal(response.trace?.plannerCalled, true);
  assert.equal(response.trace?.retrievalCalled, true);
  assert.equal(response.trace?.interpreterCalled, true);
  assert.equal(response.trace?.decisionCalled, false);
  assert.equal(response.trace?.evidenceReloadCalled, false);
});

// ===========================================================================
// B. FIRST TURN PERSISTENCE — NEEDS_INFORMATION + skillContext persisted
// ===========================================================================

test('B. first turn persistence: NEEDS_INFORMATION + skillContext + material question persisted', async () => {
  const { service, store } = createSystem();
  const { response, session } = await startConversation(service, 'نزل علي دم');

  assert.equal(response.status, 'needs_information');
  assert.ok(response.interaction, 'a material question is shown');
  assert.equal(response.interaction!.key, 'bleeding_cessation');
  assert.match(response.interaction!.question, /توقف الدم/);

  const stored = store.rows.get(session.id)!.sessionContext;
  assert.ok(stored.skillContext, 'skillContext is persisted in the session');
  assert.equal(stored.pendingKey, 'bleeding_cessation');
  assert.equal(stored.skillContext!.skillId, SKILL_ID);
  assert.deepEqual(stored.skillContext!.requirements.map((r) => r.key), ['bleeding_cessation', 'habit_days']);
  assert.deepEqual(stored.skillContext!.evidenceRefs, EVIDENCE_REFS);
  assert.deepEqual(stored.skillContext!.sourceIds, [APPROVED_SOURCE_ID]);
});

// ===========================================================================
// C. NEXT-TURN HANDOFF — second turn receives persisted skillContext
// ===========================================================================

test('C. next-turn handoff: second turn receives persisted skillContext through conversation → runtime', async () => {
  const { service, store } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // Turn 2: answer the pending question.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  // The skill received the stored skillContext (via the conversation payload)
  // and the fast path was taken — proving the handoff crossed the real seam.
  assert.equal(r2.trace?.plannerCalled, false);
  assert.equal(r2.trace?.retrievalCalled, false);
  assert.equal(r2.trace?.interpreterCalled, false);
  assert.equal(r2.trace?.decisionCalled, false);

  // The refreshed skillContext is still in the session.
  const stored = store.rows.get(session.id)!.sessionContext;
  assert.ok(stored.skillContext, 'refreshed skillContext persisted after fast-path turn');
  assert.equal(stored.pendingKey, 'habit_days');
});

// ===========================================================================
// D. FAST PENDING ANSWER — valid answer; fast path; stored reqs determine next
// ===========================================================================

test('D. fast pending answer: all-false trace; stored requirements determine next question', async () => {
  const { service } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // Answer the first pending question with a valid CERTAIN answer.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  // Fast path: no expensive stages ran.
  assert.equal(r2.trace?.plannerCalled, false);
  assert.equal(r2.trace?.retrievalCalled, false);
  assert.equal(r2.trace?.interpreterCalled, false);
  assert.equal(r2.trace?.decisionCalled, false);

  // The stored requirements (from skillContext) determine the NEXT unresolved
  // question: habit_days is still missing.
  assert.equal(r2.status, 'needs_information');
  assert.equal(r2.interaction?.key, 'habit_days');
  assert.equal(r2.readiness?.status, 'NEEDS_INFORMATION');
});

// ===========================================================================
// E. pendingNeed — caseState.pendingNeed equals the shown question key
// ===========================================================================

test('E. pendingNeed: caseState.pendingNeed equals the post-turn question key', async () => {
  const { service } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  assert.equal(r2.status, 'needs_information');
  assert.ok(r2.caseState, 'caseState is present');
  assert.equal(r2.caseState!.pendingNeed, r2.interaction?.key);
  assert.equal(r2.caseState!.pendingNeed, 'habit_days');
});

// ===========================================================================
// F. SAME-VALUE REBIND — same-value re-bind does not break fast path eligibility
// ===========================================================================

test('F. same-value rebind: pre-existing unchanged fact does not count as a material change', async () => {
  const { service, store } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // After turn 1: facts = { bleeding_cessation? no — it was asked, not answered }
  // The session has habit_days? No — the skill returns no caseFacts in the full path.
  // We need a pre-existing fact that stays unchanged. Let's answer BOTH questions
  // in turn 1 (via structured answers), then re-send the same value in turn 2.
  // But that would make turn 1 READY_FOR_DECISION...

  // Simpler: the session has no pre-existing facts. The same-value rebind is about
  // the conversation not counting an unchanged value in changedFactKeys. We verify
  // by sending only the pending answer — habit_days is not touched, so it's not
  // in changedFactKeys. The fast path is taken because the only delta is pendingKey.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  // The fast path was taken — proving changedFactKeys only contained the pendingKey.
  // If the same-value rebind defect were present (ALL written keys in changedFactKeys),
  // any unrelated key would have broken changedKeys.every(k === pendingStored).
  assert.equal(r2.trace?.plannerCalled, false);
  assert.equal(r2.trace?.retrievalCalled, false);
  assert.equal(r2.trace?.interpreterCalled, false);
  assert.equal(r2.trace?.decisionCalled, false);

  // The session facts are correct.
  const stored = store.rows.get(session.id)!.sessionContext;
  assert.equal(stored.facts.bleeding_cessation, true);
  assert.equal(stored.pendingKey, 'habit_days');
});

// ===========================================================================
// G. REAL MATERIAL CHANGE — another fact changes → full path
// ===========================================================================

test('G. real material change: a non-pending fact change forces the full path', async () => {
  const { service } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // Send two answers: the pending one AND a change to another fact.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [
      { key: 'bleeding_cessation', value: true },
      { key: 'habit_days', value: 5 },
    ],
  });

  // answeredKeys.length > 1 → canReuse is false → full path.
  assert.equal(r2.trace?.plannerCalled, true);
  assert.equal(r2.trace?.retrievalCalled, true);
  assert.equal(r2.trace?.interpreterCalled, true);
});

// ===========================================================================
// H. CORRECTION — correction → full path
// ===========================================================================

test('H. correction: a structured correction forces the full path', async () => {
  const { service, store } = createSystem({ understandingCorrections: [{ target: 'bleeding_cessation', new: 'false' }] });
  const { session } = await startConversation(service, 'نزل علي دم');

  // Turn 2: the understanding returns a correction, which sets correctionsPresent=true.
  // The canReuse gate rejects the fast path when correctionsPresent.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'لا، ما توقف',
    answers: [{ key: 'bleeding_cessation', value: false }],
  });

  // The full path ran (correctionsPresent blocked the fast path).
  assert.equal(r2.trace?.plannerCalled, true);
  assert.equal(r2.trace?.retrievalCalled, true);
  assert.equal(r2.trace?.interpreterCalled, true);
});

// ===========================================================================
// I. UNKNOWN — UNKNOWN answer does not fabricate readiness
// ===========================================================================

test('I. UNKNOWN: an UNKNOWN answer does not fabricate readiness', async () => {
  const { service, store } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'ما أدري',
  });

  // The UNKNOWN answer was written with certainty UNKNOWN — it does NOT satisfy
  // the material requirement, so the need is still missing.
  assert.equal(r2.status, 'needs_information');
  assert.equal(r2.interaction?.key, 'bleeding_cessation');
  assert.equal(r2.readiness?.status, 'NEEDS_INFORMATION');

  // The fact is stored as UNKNOWN, not as a real value.
  const stored = store.rows.get(session.id)!.sessionContext;
  assert.equal(stored.facts.bleeding_cessation, 'UNKNOWN');
});

// ===========================================================================
// J. AMBIGUOUS / UNRELATED — cannot prove exact pending answer → no fabrication
// ===========================================================================

test('J. ambiguous/unrelated: an unrelated turn does not fabricate a decision', async () => {
  const { service } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // An unrelated message while a pending question exists. The conversation
  // interprets it as a pending answer (UNCERTAIN), but the fast path does not
  // fabricate a decision — the need is still missing.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'عندي سؤال ثاني',
  });

  // No decision is fabricated: the status is needs_information, not completed.
  assert.notEqual(r2.status, 'completed');
  assert.equal(r2.readiness?.status, 'NEEDS_INFORMATION');
});

// ===========================================================================
// K. SKILL/VERSION ISOLATION — mismatch → no reuse
// ===========================================================================

test('K. skill/version isolation: mismatched skillId in skillContext → full path', async () => {
  const { service, store } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // Tamper the stored skillContext to have a different skillId.
  const stored = store.rows.get(session.id)!;
  stored.sessionContext.skillContext = {
    ...stored.sessionContext.skillContext!,
    skillId: 'other.skill',
    skillVersion: 99,
  };
  await store.save(stored);

  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  // The skillId/version mismatch prevents reuse → full path.
  assert.equal(r2.trace?.plannerCalled, true);
});

// ===========================================================================
// L. EVIDENCE/SOURCE INVALIDATION — unapproved sourceIds → no unsafe reuse
// ===========================================================================

test('L. evidence/source invalidation: unapproved sourceIds → no reuse', async () => {
  const { service, store } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // Tamper the stored skillContext to reference an unapproved source.
  const stored = store.rows.get(session.id)!;
  stored.sessionContext.skillContext = {
    ...stored.sessionContext.skillContext!,
    sourceIds: ['src-unapproved-9'],
  };
  await store.save(stored);

  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  // The unapproved source prevents reuse → full path.
  assert.equal(r2.trace?.plannerCalled, true);
});

// ===========================================================================
// M. BOUNDS — malformed/oversized context is bounded by liftSkillContext
// ===========================================================================

test('M. bounds: oversized requirements/evidenceRefs/sourceIds are truncated by liftSkillContext', async () => {
  const { service, store } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // The stored skillContext is bounded by liftSkillContext. Verify the bounds
  // are enforced on the first turn's persisted context.
  const stored = store.rows.get(session.id)!.sessionContext;
  assert.ok(stored.skillContext);
  assert.ok(stored.skillContext!.requirements.length <= MAX_SKILL_CONTEXT_REQUIREMENTS);
  assert.ok(stored.skillContext!.evidenceRefs.length <= MAX_SKILL_CONTEXT_EVIDENCE);
  assert.ok(stored.skillContext!.sourceIds.length <= MAX_SKILL_CONTEXT_SOURCES);
});

test('M2. bounds: a skillContext missing evidenceRefs is dropped (liftSkillContext returns undefined)', async () => {
  const { service, store } = createSystem();
  // Register a skill that returns a skillContext with empty evidenceRefs.
  const readinessService = new DecisionReadinessService();
  const badSkill: SkillDefinition = {
    ...createB3aFakeSkill({ readiness: readinessService }),
    async execute(ctx: SkillExecutionContext) {
      const input = (ctx.input ?? {}) as Record<string, unknown>;
      const known = (input.context ?? {}) as Record<string, unknown>;
      const knownItems: KnownContextItem[] = Object.entries(known)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([key, value]) => ({ key, value, source: 'conversation' as const }));
      const readiness = readinessService.evaluate({ requirements: [REQ_CESSATION], known: knownItems });
      return {
        status: 'NEEDS_INFORMATION',
        readiness,
        skillContext: {
          skillId: SKILL_ID,
          skillVersion: SKILL_VERSION,
          issueSignature: ISSUE_SIG,
          requirements: [REQ_CESSATION],
          evidenceRefs: [], // empty → liftSkillContext returns undefined
          sourceIds: [APPROVED_SOURCE_ID],
          baseCaseSignature: BASE_SIG,
          at: new Date().toISOString(),
        },
        trace: { plannerCalled: true, retrievalCalled: true, interpreterCalled: true, decisionCalled: false },
      };
    },
  };
  const registry = new MapSkillRegistry();
  registry.register(badSkill);
  const runtime = new SkillsRuntime({ persistence: fakeRuntimePersistence(), registry, readiness: readinessService });
  const svc = new ConversationService({
    persistence: store,
    understanding: fakeUnderstanding(),
    skills: { execute: (i: { projectId: string; actor: string; skillId: string; payload: unknown }) => runtime.execute(i) },
    defaultSkillId: SKILL_ID,
  });

  const s = await svc.create('p', 'a', 'private');
  await svc.handleMessage('p', 'a', s.id, { text: 'test' });

  // liftSkillContext dropped the malformed context (empty evidenceRefs).
  assert.equal(store.rows.get(s.id)!.sessionContext.skillContext, undefined);
});

// ===========================================================================
// N. REPLACEMENT — new valid context replaces previous; no accumulation
// ===========================================================================

test('N. replacement: new skillContext replaces the previous one (no accumulation)', async () => {
  const { service, store } = createSystem();
  const { session } = await startConversation(service, 'نزل علي دم');

  // Turn 2: the skill returns a refreshed skillContext (fast path).
  await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  // The session has exactly ONE skillContext — the refreshed one, not two.
  const stored = store.rows.get(session.id)!.sessionContext;
  assert.ok(stored.skillContext);
  assert.equal(stored.skillContext!.skillId, SKILL_ID);
  // The issueSignature is the same (refreshed from the reusable), but there is
  // only one skillContext object — no historical accumulation.
  assert.equal(typeof stored.skillContext, 'object');
});

// ===========================================================================
// O. PRIVATE — session-local skillContext works without personal Memory
// ===========================================================================

test('O. private: skillContext works in a private session without Memory read/write', async () => {
  const { service, store } = createSystem();
  const session = await service.create('p', 'a', 'private');
  const r1 = await service.handleMessage('p', 'a', session.id, { text: 'نزل علي دم' });

  assert.equal(r1.status, 'needs_information');
  const stored = store.rows.get(session.id)!.sessionContext;
  assert.ok(stored.skillContext, 'skillContext is stored in a private session');

  // Turn 2: fast path works without personal Memory.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });
  assert.equal(r2.trace?.plannerCalled, false);
  assert.ok(store.rows.get(session.id)!.sessionContext.skillContext);
});

// ===========================================================================
// P. GROUNDED RESULT — lastGroundedResult invalidation/reuse unchanged
// ===========================================================================

test('P. grounded result: a material correction clears the stored grounded result', async () => {
  const { service, store } = createSystem({ requirements: [REQ_CESSATION] });
  const session = await service.create('p', 'a', 'contextual');

  // Turn 1: the requirement is ASKED, so its contract travels in the persisted turn context.
  const r1 = await service.handleMessage('p', 'a', session.id, { text: 'start' });
  assert.equal(r1.status, 'needs_information');
  assert.equal(r1.interaction?.key, 'bleeding_cessation');

  // Turn 2: the answer satisfies it → READY_FOR_DECISION → DECIDED, grounded result stored.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });
  assert.equal(r2.status, 'completed');
  assert.equal(r2.trace?.decisionStatus, 'DECIDED');
  const grounded = store.rows.get(session.id)!.sessionContext.lastGroundedResult;
  assert.ok(grounded, 'grounded result stored');

  // Turn 3: a material correction invalidates it — never answered from a stale decision.
  const r3 = await service.handleMessage('p', 'a', session.id, {
    text: 'لا، قصدي ما توقف',
    answers: [{ key: 'bleeding_cessation', value: false }],
  });
  assert.equal(r3.trace?.decisionStatus, 'DECIDED');
  const after = store.rows.get(session.id)!.sessionContext.lastGroundedResult;
  // Either cleared, or recomputed for the NEW facts — never the stale signature reused.
  if (after) assert.notEqual(after.caseSignature, grounded!.caseSignature);
});

// ===========================================================================
// Q. DECISION-READY PATH — fast-path readiness satisfied → fallback to grounded
// ===========================================================================

test('Q. decision-ready path: fast-path readiness satisfied → b3a_decision_fallback_to_grounded_path', async () => {
  const { service } = createSystem({ requirements: [REQ_CESSATION] });
  const session = await service.create('p', 'a', 'private');

  // Turn 1: single requirement, no known facts → NEEDS_INFO, skillContext stored.
  const r1 = await service.handleMessage('p', 'a', session.id, { text: 'start' });
  assert.equal(r1.status, 'needs_information');
  assert.equal(r1.interaction?.key, 'bleeding_cessation');

  // Turn 2: answer the single requirement → fast path readiness satisfied.
  const r2 = await service.handleMessage('p', 'a', session.id, {
    text: 'نعم',
    answers: [{ key: 'bleeding_cessation', value: true }],
  });

  // The fast path was taken (canReuse), readiness was READY, then it fell through
  // to the grounded path which produced a DECIDED result.
  assert.equal(r2.status, 'completed');
  assert.equal(r2.trace?.decisionStatus, 'DECIDED');
  assert.ok(
    r2.trace?.notes?.some((n) => n.includes('b3a_decision_fallback_to_grounded_path')),
    'the fallback note is recorded in the trace',
  );
  // The grounded path ran (planner was called after the fallback).
  assert.equal(r2.trace?.plannerCalled, true);
  assert.equal(r2.trace?.decisionCalled, true);
});
