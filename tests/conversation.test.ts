/**
 * K23 Conversation — service tests (fake persistence; deterministic, no model).
 * Live API + Supabase + isolation + restart are proven in scripts/_k23live.mjs / _k23iso.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import { policyFor, type ConversationSession } from '../src/core/conversation/conversation.ts';
import { emptySessionContext } from '../src/core/conversation/conversation.ts';
import { conversationEligibilityFixture } from '../src/core/skill/conversation-eligibility-fixture.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
    async save(s: ConversationSession) { rows.set(s.id, s); return s; },
  };
}
const readiness = new DecisionReadinessService();
function svc(store: ReturnType<typeof fakeStore>, memory: Array<{ memoryKey: string; value: unknown }> = []) {
  return new ConversationService({
    persistence: store,
    understanding: { evaluate: async ({ text }) => ({ status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'en', issues: [text], references: { resolved: true }, corrections: [], facts: [], ambiguity: { material: false }, contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] } }) },
    skills: {
      execute: async ({ payload }) => {
        const facts = ((payload as Record<string, unknown>).context ?? {}) as Record<string, unknown>;
        const known = Object.entries(facts).map(([key, value]) => ({ key, value, source: 'user' as const }));
        const r = readiness.evaluate({ requirements: conversationEligibilityFixture.readiness!.requirements, known });
        return r.status === 'READY_FOR_DECISION'
          ? { status: 'completed', skillId: 'demo.conversation-eligibility', skillVersion: 1, runId: 'run1', readiness: r }
          : { status: 'needs_information', skillId: 'demo.conversation-eligibility', skillVersion: 1, runId: 'run1', readiness: r };
      },
    },
    memory: { fetchBounded: async () => ({ user: memory.map((m) => ({ id: 'm', scope: 'user', memoryType: 'p', memoryKey: m.memoryKey, payload: { value: m.value } })), conversation: [], case: [] }) },
    defaultSkillId: 'demo.conversation-eligibility',
    interactionsFor: () => ({ event_date: { type: 'date' }, duration_days: { type: 'duration' } }),
  });
}

test('context policy: private denies personal memory read/write', () => {
  assert.deepEqual(policyFor('private'), { mode: 'private', personalMemoryRead: false, personalMemoryWrite: false, projectDefaults: true });
  assert.equal(policyFor('contextual').personalMemoryRead, true);
  assert.equal(policyFor('contextual').personalMemoryWrite, false);
});

test('contextual multi-turn continuity: interaction -> answer -> READY', async () => {
  const store = fakeStore();
  const c = svc(store);
  const s = await c.create('p', 'a', 'contextual');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'start' });
  assert.equal(t1.status, 'needs_information');
  assert.equal(t1.interaction?.key, 'event_date');
  assert.equal(t1.interaction?.type, 'date');
  const t2 = await c.handleMessage('p', 'a', s.id, { text: '2026-01-10', answers: [{ key: 'event_date', value: '2026-01-10' }] });
  assert.equal(t2.interaction?.key, 'duration_days'); // session context retained event_date
  const t3 = await c.handleMessage('p', 'a', s.id, { text: '6' }); // free-text fallback
  assert.equal(t3.status, 'completed');
  assert.equal(t3.readiness?.status, 'READY_FOR_DECISION');
});

test('private: personal memory read is NOT used (no contamination)', async () => {
  const store = fakeStore();
  const c = svc(store, [{ memoryKey: 'duration_days', value: 9 }]); // personal memory has it
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'start' });
  // private -> duration_days NOT satisfied from memory; first question is event_date
  assert.equal(t1.readiness?.missingKeys?.includes('duration_days'), true);
});

test('contextual: bounded personal memory prevents a duplicate question', async () => {
  const store = fakeStore();
  const c = svc(store, [{ memoryKey: 'duration_days', value: 9 }]);
  const s = await c.create('p', 'a', 'contextual');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'start' });
  assert.equal(t1.readiness?.missingKeys?.includes('duration_days'), false); // known -> not asked
});

test('stages reflect real work only (no fake reasoning)', async () => {
  const store = fakeStore();
  const c = svc(store);
  const s = await c.create('p', 'a', 'contextual');
  const t = await c.handleMessage('p', 'a', s.id, { text: 'start' });
  assert.deepEqual(t.stages, ['UNDERSTANDING', 'CONTEXT_RETRIEVAL', 'CHECKING_READINESS', 'PREPARING_RESPONSE']);
  assert.equal(t.stages.includes('KNOWLEDGE_RETRIEVAL' as never), false);
  assert.equal(t.stages.includes('REASONING' as never), false);
});

test('session isolation: another project/actor cannot load the session', async () => {
  const store = fakeStore();
  const c = svc(store);
  const s = await c.create('pA', 'a', 'contextual');
  await assert.rejects(c.handleMessage('pB', 'a', s.id, { text: 'x' }), /المحادثة/);
  await assert.rejects(c.handleMessage('pA', 'other', s.id, { text: 'x' }), /المحادثة/);
});

test('no persistent personal memory write from a private session', async () => {
  const store = fakeStore();
  const c = svc(store);
  const s = await c.create('p', 'a', 'private');
  const before = JSON.stringify([...store.rows.values()].map((x) => x.sessionContext.facts));
  await c.handleMessage('p', 'a', s.id, { text: 'x', answers: [{ key: 'duration_days', value: 4 }] });
  // the fact lives ONLY in the session context (store), never elsewhere
  const session = store.rows.get(s.id)!;
  assert.equal(session.sessionContext.facts.duration_days, 4);
  assert.ok(before.length >= 0);
});

test('invalid input rejected', async () => {
  const store = fakeStore();
  const c = svc(store);
  const s = await c.create('p', 'a', 'contextual');
  await assert.rejects(c.handleMessage('p', 'a', s.id, { text: '   ' }), /مدخلات/);
});

test('emptySessionContext shape', () => {
  assert.deepEqual(emptySessionContext(), { facts: {}, turnCount: 0, recentTurns: [] });
});

/**
 * Correcting a fact the conversation is currently asking for: K19 returns the
 * correction as a structured interpretation, K23 replaces that SESSION fact
 * (never personal Memory), readiness recomputes, and the flow reaches its
 * terminal state instead of dead-ending.
 */
test('a structured correction replaces the pending session fact and readiness recomputes', async () => {
  const store = fakeStore();
  let turn = 0;
  const scripted = new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR',
        dialogueAct: ++turn === 2 ? 'CORRECTION' : 'STATEMENT',
        language: 'ar',
        issues: [text],
        references: { resolved: true },
        corrections: turn === 2 ? [{ new: '2026-09-10' }] : [],
        facts: [],
        ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async ({ payload }) => {
        const facts = ((payload as Record<string, unknown>).context ?? {}) as Record<string, unknown>;
        const known = Object.entries(facts).map(([key, value]) => ({ key, value, source: 'user' as const }));
        const r = readiness.evaluate({ requirements: conversationEligibilityFixture.readiness!.requirements, known });
        return r.status === 'READY_FOR_DECISION'
          ? { status: 'completed', skillId: 'demo.conversation-eligibility', skillVersion: 1, runId: 'run1', readiness: r }
          : { status: 'needs_information', skillId: 'demo.conversation-eligibility', skillVersion: 1, runId: 'run1', readiness: r };
      },
    },
    defaultSkillId: 'demo.conversation-eligibility',
    interactionsFor: () => ({ event_date: { type: 'date' }, duration_days: { type: 'duration' } }),
  });

  const s = await scripted.create('p', 'a', 'private');
  const t1 = await scripted.handleMessage('p', 'a', s.id, { text: 'start' });
  assert.equal(t1.interaction?.key, 'event_date');

  // The user corrects the fact KIP is asking about (no structured answer sent).
  const t2 = await scripted.handleMessage('p', 'a', s.id, { text: 'لا، قصدي 2026-09-10' });
  assert.equal(t2.understanding.dialogueAct, 'CORRECTION');
  assert.equal(store.rows.get(s.id)!.sessionContext.facts.event_date, '2026-09-10');
  // readiness recomputes from the corrected facts and asks the next real gap
  assert.deepEqual(t2.readiness?.missingKeys, ['duration_days']);
  assert.equal(t2.interaction?.key, 'duration_days');
  assert.equal(t2.interaction?.question, 'كم يوماً استمر هذا الحدث؟');

  // ... and the conversation still reaches its terminal state.
  const t3 = await scripted.handleMessage('p', 'a', s.id, { text: '6', answers: [{ key: 'duration_days', value: 6 }] });
  assert.equal(t3.status, 'completed');
  assert.equal(t3.readiness?.status, 'READY_FOR_DECISION');
});

test('a correction never invents a fact when nothing is pending', async () => {
  const store = fakeStore();
  const c = new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR', dialogueAct: 'CORRECTION', language: 'ar', issues: [text],
        references: { resolved: true }, corrections: [{ new: '9' }], facts: [],
        ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async ({ payload }) => {
        const facts = ((payload as Record<string, unknown>).context ?? {}) as Record<string, unknown>;
        const known = Object.entries(facts).map(([key, value]) => ({ key, value, source: 'user' as const }));
        const r = readiness.evaluate({ requirements: conversationEligibilityFixture.readiness!.requirements, known });
        return { status: 'needs_information', skillId: 'demo.conversation-eligibility', skillVersion: 1, runId: 'run1', readiness: r };
      },
    },
    defaultSkillId: 'demo.conversation-eligibility',
    interactionsFor: () => ({}),
  });
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'لا، قصدي 9' });
  // no pending requirement and no resolved target => the session gains NO fact
  assert.deepEqual(store.rows.get(s.id)!.sessionContext.facts, {});
});

/**
 * K25 seam: a skill that derives its requirements DYNAMICALLY (no static
 * readiness, no static interaction hints) must still reach the user as a real
 * question with the right control — the requirement carries its own interaction.
 */
test('dynamic requirement: the conversation renders the requirement-owned control and bounded trace', async () => {
  const store = fakeStore();
  const requirement = {
    key: 'bleeding_stopped',
    description: 'شرط الاتصال',
    material: true,
    question: { key: 'bleeding_stopped', wording: 'قبل ما تشوفين هذا السائل، كان الدم وقف تمامًا أو كان ما زال ينزل؟' },
    interaction: { type: 'single_choice', options: ['توقف تمامًا', 'كان ينزل'], allowOther: true },
  };
  const dynamic = new ConversationService({
    persistence: store,
    understanding: { evaluate: async ({ text }) => ({ status: 'CLEAR', dialogueAct: 'QUESTION', language: 'ar', issues: [text], references: { resolved: true }, corrections: [], facts: [], ambiguity: { material: false }, contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] } }) },
    skills: {
      execute: async () => {
        const r = readiness.evaluate({ requirements: [requirement], known: [] });
        return {
          status: 'needs_information', skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'run9', readiness: r,
          trace: { issue: 'حكم إفرازة في آخر أيام الحيض', status: 'NEEDS_INFORMATION+SOURCE_GAP', approvedSourceIds: ['s1'], requirementKeys: ['bleeding_stopped'], notes: ['observation_not_defined_by_approved_source'] },
        };
      },
    },
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
    defaultSkillId: 'naqaa.fiqh-hayd',
    interactionsFor: () => ({}), // NO static hints: the requirement must carry the control
  });
  const s = await dynamic.create('p', 'a', 'private');
  const t1 = await dynamic.handleMessage('p', 'a', s.id, { text: 'نزل علي سائل شفاف مع لمعة حمراء خفيفة .. هل هذا حيض ؟' });
  assert.equal(t1.status, 'needs_information');
  assert.equal(t1.interaction?.key, 'bleeding_stopped');
  assert.equal(t1.interaction?.type, 'single_choice');
  assert.deepEqual(t1.interaction?.options, ['توقف تمامًا', 'كان ينزل']);
  assert.equal(t1.interaction?.allowOther, true);
  assert.match(t1.interaction!.question, /كان الدم وقف/);
  assert.equal(t1.runId, 'run9');
  // the bounded skill trace reaches the admin surface (no reasoning, no prompts)
  assert.equal(t1.trace?.issue, 'حكم إفرازة في آخر أيام الحيض');
  assert.deepEqual(t1.trace?.requirementKeys, ['bleeding_stopped']);
});

/**
 * K25 slice 2 seam: when the executed skill returns a grounded user-facing answer,
 * the conversation renders THAT text (never the generic placeholder) and forwards
 * the answer (with its source) to the client for display.
 */
test('a skill answer replaces the placeholder and is forwarded with its source', async () => {
  const store = fakeStore();
  const grounding = new ConversationService({
    persistence: store,
    understanding: { evaluate: async ({ text }) => ({ status: 'CLEAR', dialogueAct: 'QUESTION', language: 'ar', issues: [text], references: { resolved: true }, corrections: [], facts: [], ambiguity: { material: false }, contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] } }) },
    skills: {
      execute: async () => ({
        status: 'completed', skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'run11',
        answer: { text: 'هذا السائل ليس حيضًا.\nلأن الحيض له صفات معروفة، وهذا الوصف ليس منها.', sourceTitle: 'الحيض الالوكة', evidenceIds: ['chunk-7', 'chunk-8'], label: 'ليس حيضًا' },
        trace: { status: 'DECIDED', decisionStatus: 'DECIDED', decisionLabel: 'ليس حيضًا', confidence: 'MEDIUM', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['chunk-7', 'chunk-8'], workload: 'knowledge_answer' },
      }),
    },
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
    defaultSkillId: 'naqaa.fiqh-hayd',
  });
  const s = await grounding.create('p', 'a', 'contextual');
  const t = await grounding.handleMessage('p', 'a', s.id, { text: 'نزل سائل شفاف في آخر دورتي .. هل هو حيض؟' });
  assert.equal(t.status, 'completed');
  assert.notEqual(t.message, 'تمت معالجة طلبك.');
  assert.match(t.message, /ليس حيضًا/);
  assert.equal(t.answer?.sourceTitle, 'الحيض الالوكة');
  assert.deepEqual(t.answer?.evidenceIds, ['chunk-7', 'chunk-8']);
  assert.equal(t.trace?.decisionStatus, 'DECIDED');
  assert.equal(t.trace?.workload, 'knowledge_answer');
});

test('the generic placeholder is still used when a skill has nothing to say', async () => {
  const store = fakeStore();
  const silent = new ConversationService({
    persistence: store,
    understanding: { evaluate: async ({ text }) => ({ status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'ar', issues: [text], references: { resolved: true }, corrections: [], facts: [], ambiguity: { material: false }, contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] } }) },
    skills: { execute: async () => ({ status: 'completed', skillId: 'demo.context-summary', skillVersion: 1, runId: 'run12' }) },
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
    defaultSkillId: 'demo.context-summary',
  });
  const s = await silent.create('p', 'a', 'private');
  const t = await silent.handleMessage('p', 'a', s.id, { text: 'ملخص' });
  assert.equal(t.message, 'تمت معالجة طلبك.');
  assert.equal(t.answer, undefined);
});

/**
 * K25 — bounded session result: the latest GROUNDED terminal result is remembered in
 * the session context so a follow-up can be answered from it, and it is CLEARED the
 * moment a material fact is corrected (never answered from a stale decision).
 */
const understandingFake = (corrections: Array<{ target?: string; previous?: unknown; new: unknown }> = []) => ({
  evaluate: async ({ text }: { text: string }) => ({
    status: 'CLEAR' as const, dialogueAct: 'QUESTION' as const, language: 'ar' as const, issues: [text], references: { resolved: true },
    corrections, facts: [], ambiguity: { material: false }, contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
  }),
});

const groundedSkillFake = (seen: Array<Record<string, unknown>>) => ({
  execute: async (input: { payload?: unknown }) => {
    seen.push((input.payload ?? {}) as Record<string, unknown>);
    return {
      status: 'completed' as const, skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'run-g',
      answer: { text: 'هذا الدم ليس حيضًا.', sourceTitle: 'الحيض الالوكة', evidenceIds: ['chunk-7', 'chunk-8'], label: 'ليس حيضًا' },
      trace: { status: 'DECIDED' as const, decisionStatus: 'DECIDED' as const, decisionLabel: 'ليس حيضًا', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['chunk-7', 'chunk-8'] },
    };
  },
});

test('the grounded result is stored in the session and handed to the next turn', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = new ConversationService({
    persistence: store,
    understanding: understandingFake() as never,
    skills: groundedSkillFake(seen) as never,
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
    defaultSkillId: 'naqaa.fiqh-hayd',
  });
  const sess = await c.create('p', 'a', 'contextual');
  const t1 = await c.handleMessage('p', 'a', sess.id, { text: 'نزل دم ٦ ساعات فقط. هل هو حيض؟' });
  assert.equal(t1.trace?.decisionStatus, 'DECIDED');
  const stored = store.rows.get(sess.id)!.sessionContext.lastGroundedResult;
  assert.ok(stored, 'the grounded result is kept in the session context');
  assert.equal(stored!.skillId, 'naqaa.fiqh-hayd');
  assert.equal(stored!.decision, 'ليس حيضًا');
  assert.equal(stored!.sourceTitle, 'الحيض الالوكة');
  assert.deepEqual(stored!.evidenceRefs, ['chunk-7', 'chunk-8']);
  // the next turn receives it (so a follow-up can be answered from it)
  await c.handleMessage('p', 'a', sess.id, { text: 'شنو المصدر؟' });
  assert.ok(seen[1].lastGroundedResult, 'the bounded result is passed to the skill');
});

test('a material correction CLEARS the stored grounded result before answering', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = new ConversationService({
    persistence: store,
    understanding: understandingFake([{ target: 'bleeding_stopped', new: 'لم يتوقف' }]) as never,
    skills: groundedSkillFake(seen) as never,
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
    defaultSkillId: 'naqaa.fiqh-hayd',
  });
  const sess = await c.create('p', 'a', 'contextual');
  await c.handleMessage('p', 'a', sess.id, { text: 'نزل دم ٦ ساعات فقط. هل هو حيض؟' });
  assert.ok(store.rows.get(sess.id)!.sessionContext.lastGroundedResult, 'stored first');
  // a correction arrives while the stored result exists
  await c.handleMessage('p', 'a', sess.id, { text: 'لا، الدم ما توقف بعد ٦ ساعات، استمر يومًا وليلة' });
  assert.equal(seen[1].lastGroundedResult, undefined, 'the stale result is NOT handed to the skill');
  // the corrected turn reasons again from the updated facts; whatever it stores is a
  // NEW result for the NEW case, never the previous decision reused as authority.
  assert.equal(store.rows.get(sess.id)!.sessionContext.turnCount, 2);
  assert.equal(seen[1].lastGroundedResult, undefined);
});
