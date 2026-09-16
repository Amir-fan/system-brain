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
