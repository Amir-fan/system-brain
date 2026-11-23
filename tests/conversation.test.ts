/**
 * K23 Conversation — service tests (fake persistence; deterministic, no model).
 * Live API + Supabase + isolation + restart are proven in scripts/_k23live.mjs / _k23iso.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ConversationService, type ConversationDeps } from '../src/core/conversation/conversation.service.ts';
import { policyFor, type ConversationSession } from '../src/core/conversation/conversation.ts';
import { emptySessionContext } from '../src/core/conversation/conversation.ts';
import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';
import { conversationEligibilityFixture } from '../src/core/skill/conversation-eligibility-fixture.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import type { DecisionRequirement } from '../src/core/readiness/readiness.ts';

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  const expectedVersions: Array<string | undefined> = [];
  return {
    rows,
    expectedVersions,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
    async save(s: ConversationSession, expectedUpdatedAt?: string) {
      expectedVersions.push(expectedUpdatedAt);
      rows.set(s.id, s);
      return s;
    },
  };
}
const readiness = new DecisionReadinessService();
function svc(
  store: ReturnType<typeof fakeStore>,
  memory: Array<{ memoryKey: string; value: unknown }> = [],
  executeSkill?: ConversationDeps['skills']['execute'],
) {
  return new ConversationService({
    persistence: store,
    understanding: { evaluate: async ({ text }) => ({ status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'en', issues: [text], references: { resolved: true }, corrections: [], facts: [], ambiguity: { material: false }, contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] } }) },
    skills: {
      execute: executeSkill ?? (async ({ payload }) => {
        const facts = ((payload as Record<string, unknown>).context ?? {}) as Record<string, unknown>;
        const known = Object.entries(facts).map(([key, value]) => ({ key, value, source: 'user' as const }));
        const r = readiness.evaluate({ requirements: conversationEligibilityFixture.readiness!.requirements, known });
        return r.status === 'READY_FOR_DECISION'
          ? { status: 'completed', skillId: 'demo.conversation-eligibility', skillVersion: 1, runId: 'run1', readiness: r }
          : { status: 'needs_information', skillId: 'demo.conversation-eligibility', skillVersion: 1, runId: 'run1', readiness: r };
      }),
    },
    memory: { fetchBounded: async () => ({ user: memory.map((m) => ({ id: 'm', scope: 'user', memoryType: 'p', memoryKey: m.memoryKey, payload: { value: m.value } })), conversation: [], case: [] }) },
    defaultSkillId: 'demo.conversation-eligibility',
    interactionsFor: () => ({ event_date: { type: 'date' }, duration_days: { type: 'duration' } }),
  });
}

function delayedSkill() {
  const calls: string[] = [];
  let release!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { release = resolve; });
  const execute: ConversationDeps['skills']['execute'] = async ({ skillId }) => {
    calls.push(`start ${skillId}`);
    if (skillId === 'slow') await firstMayFinish;
    calls.push(`finish ${skillId}`);
    return { status: 'completed', skillId, skillVersion: 1, runId: `run-${skillId}` };
  };
  return { execute, calls, release };
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

for (const useUuidAliases of [false, true]) {
  const testName = useUuidAliases
    ? 'concurrent turns with equivalent UUID spellings use the same conversation queue'
    : 'concurrent turns on one conversation serialize skill calls and save both turns once';
  test(testName, async () => {
    const store = fakeStore();
    const skill = delayedSkill();
    const c = svc(store, [], skill.execute);
    const projectId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const session = await c.create(projectId, 'a', 'contextual');
    const secondProjectId = useUuidAliases ? projectId.toUpperCase() : projectId;
    const secondConversationId = useUuidAliases ? `{${session.id.replaceAll('-', '')}}` : session.id;
    if (useUuidAliases) {
      const get = store.get;
      // The UUID columns resolve both spellings to the same row.
      store.get = (project, actor, id) => project === secondProjectId && id === secondConversationId
        ? get(projectId, actor, session.id)
        : get(project, actor, id);
    }

    const turns = Promise.all([
      c.handleMessage(projectId, 'a', session.id, { text: 'first concurrent turn', skillId: 'slow' }),
      c.handleMessage(secondProjectId, 'a', secondConversationId, { text: 'second concurrent turn', skillId: 'fast' }),
    ]);
    await setImmediate();
    const callsWhileFirstWasBlocked = [...skill.calls];
    skill.release();
    await turns;

    assert.deepEqual(callsWhileFirstWasBlocked, ['start slow']);
    assert.deepEqual(skill.calls, ['start slow', 'finish slow', 'start fast', 'finish fast']);
    const context = store.rows.get(session.id)!.sessionContext;
    assert.equal(context.turnCount, 2);
    assert.deepEqual(
      context.recentTurns.filter((turn) => turn.role === 'user').map((turn) => turn.text),
      ['first concurrent turn', 'second concurrent turn'],
    );
  });
}

test('a turn on a different conversation finishes while the first skill call waits', async () => {
  const store = fakeStore();
  const skill = delayedSkill();
  const c = svc(store, [], skill.execute);
  const first = await c.create('p', 'a', 'contextual');
  const second = await c.create('p', 'a', 'contextual');

  const turns = Promise.all([
    c.handleMessage('p', 'a', first.id, { text: 'first conversation', skillId: 'slow' }),
    c.handleMessage('p', 'a', second.id, { text: 'second conversation', skillId: 'fast' }),
  ]);
  await setImmediate();
  const callsWhileFirstWasBlocked = [...skill.calls];
  const countsWhileFirstWasBlocked = [first, second].map((session) => store.rows.get(session.id)!.sessionContext.turnCount);
  skill.release();
  await turns;

  assert.deepEqual(callsWhileFirstWasBlocked, ['start slow', 'start fast', 'finish fast']);
  assert.deepEqual(countsWhileFirstWasBlocked, [0, 1]);
  assert.equal(store.rows.get(first.id)!.sessionContext.turnCount, 1);
});

test('turns at the same time save against the version they read and advance it', async (t) => {
  const store = fakeStore();
  const c = svc(store);
  const session = await c.create('p', 'a', 'contextual');
  const createdMs = Date.parse(session.updatedAt);
  t.mock.method(Date, 'now', () => createdMs);

  await c.handleMessage('p', 'a', session.id, { text: 'first versioned turn' });
  await c.handleMessage('p', 'a', session.id, { text: 'second versioned turn' });

  assert.deepEqual(store.expectedVersions, [session.updatedAt, new Date(createdMs + 1).toISOString()]);
  assert.equal(store.rows.get(session.id)!.updatedAt, new Date(createdMs + 2).toISOString());
});

test('a failed turn releases the next request already waiting in the conversation queue', async () => {
  const store = fakeStore();
  const save = store.save.bind(store);
  let failNextSave = true;
  store.save = async (session, expectedUpdatedAt) => {
    if (failNextSave) {
      failNextSave = false;
      throw new Error('simulated save failure');
    }
    return save(session, expectedUpdatedAt);
  };
  const c = svc(store);
  const s = await c.create('p', 'a', 'contextual');

  const failedTurn = c.handleMessage('p', 'a', s.id, { text: 'failed turn' });
  const queuedTurn = c.handleMessage('p', 'a', s.id, { text: 'next turn' });
  await assert.rejects(failedTurn, /simulated save failure/);
  await queuedTurn;

  assert.equal(store.rows.get(s.id)!.sessionContext.turnCount, 1);
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

test('only the whole explicit correction and its actual value authorize a replacement', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR', dialogueAct: 'CORRECTION', language: 'en', issues: [text],
        references: { resolved: true }, corrections: [{ target: 'duration_days', new: '6' }], facts: [], candidates: [],
        ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async ({ payload }) => {
        seen.push(payload as Record<string, unknown>);
        return { status: 'completed', skillId: 'test.correction', skillVersion: 1, runId: 'run-question-correction' };
      },
    },
    defaultSkillId: 'test.correction',
  });
  const session = await c.create('p', 'a', 'contextual');
  const stored = store.rows.get(session.id)!;
  stored.sessionContext.facts.duration_days = 5;
  stored.sessionContext.factMeta = {
    duration_days: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' },
  };

  for (const text of ['I mean 6?', 'I mean could I wait 6 days', 'I mean 6 days and then what', 'I meant maybe 6']) {
    await c.handleMessage('p', 'a', session.id, { text });
    assert.equal(store.rows.get(session.id)!.sessionContext.facts.duration_days, 5, text);
    assert.equal((seen.at(-1)?.context as Record<string, unknown>).duration_days, 5, text);
    assert.equal(seen.at(-1)?.correctionsPresent, false, text);
  }

  await c.handleMessage('p', 'a', session.id, { text: 'I meant 7' });
  assert.equal(store.rows.get(session.id)!.sessionContext.facts.duration_days, 7);
});

test('a skill proposal cannot consume a pending question or overwrite its unknown answer', async () => {
  const store = fakeStore();
  const c = new ConversationService({
    persistence: store,
    understanding: new UnderstandingService(),
    skills: {
      execute: async () => ({
        status: 'completed', skillId: 'test.proposal', skillVersion: 1, runId: 'run-proposal',
        caseFacts: { duration_days: 6 },
      }),
    },
    defaultSkillId: 'test.proposal',
  });
  const session = await c.create('p', 'a', 'contextual');
  const stored = store.rows.get(session.id)!;
  stored.sessionContext.pendingKey = 'duration_days';
  stored.sessionContext.pendingInteraction = { type: 'number' };
  stored.sessionContext.pendingInteractionTrust = { skillId: 'test.proposal', declared: true };

  await c.handleMessage('p', 'a', session.id, { text: 'ما أدري' });
  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(state.pendingKey, 'duration_days');
  assert.equal(state.facts.duration_days, 'UNKNOWN');
  assert.equal(state.factMeta?.duration_days?.certainty, 'UNKNOWN');
});

for (const type of ['single_choice', 'free_text'] as const) {
  test(`admission hardening: a later correction must honor the original dynamic ${type} contract`, async () => {
    const store = fakeStore();
    const key = 'observed_on';
    const interaction = { type, ...(type === 'single_choice' ? { options: ['2026-11-01', '2026-11-03'] } : {}) };
    const requirement = { key, description: 'What did you observe?', material: true, question: { key, wording: 'What did you observe?' }, interaction };
    const c = new ConversationService({
      persistence: store, understanding: new UnderstandingService(), defaultSkillId: 'test.dynamic',
      skills: {
        async execute({ payload, skillId }) {
          const ask = (payload as { text: string }).text === 'Start';
          return { status: 'completed', skillId, skillVersion: 1, runId: 'run-dynamic',
            ...(ask ? { readiness: readiness.evaluate({ known: [], requirements: [requirement] }) } : {}) };
        },
      },
    });
    const session = await c.create('p', 'a', 'contextual');
    await c.handleMessage('p', 'a', session.id, { text: 'Start' });
    await c.handleMessage('p', 'a', session.id, { text: '2026-11-01', answers: [{ key, value: '2026-11-01' }] });
    await c.handleMessage('p', 'a', session.id, { text: 'I meant 2026-11-02' });
    assert.equal(store.rows.get(session.id)?.sessionContext.facts[key], '2026-11-01');
    if (type === 'single_choice') {
      await c.handleMessage('p', 'a', session.id, { text: 'I meant 2026-11-03' });
      assert.equal(store.rows.get(session.id)?.sessionContext.facts[key], '2026-11-03');
    }
  });
}

test('admission hardening: a different skill cannot answer a pending contract issued by another skill', async () => {
  const store = fakeStore();
  const c = svc(store);
  const session = await c.create('p', 'a', 'contextual');
  const first = await c.handleMessage('p', 'a', session.id, { text: 'Start' });
  const key = first.interaction!.key;
  await c.handleMessage('p', 'a', session.id, { text: '2026-11-01', skillId: 'other-skill' });
  assert.equal(store.rows.get(session.id)?.sessionContext.facts[key], undefined);
});

test('admission hardening: an unowned legacy pending free-text display cannot authorize a structured value', async () => {
  const store = fakeStore();
  const c = svc(store);
  const session = await c.create('p', 'a', 'contextual');
  const stored = store.rows.get(session.id)!.sessionContext;
  stored.pendingKey = 'legacy_question';
  stored.pendingInteraction = { type: 'free_text' };
  await c.handleMessage('p', 'a', session.id, { text: '2026-11-01', answers: [{ key: 'legacy_question', value: '2026-11-01' }] });
  assert.equal(store.rows.get(session.id)?.sessionContext.facts.legacy_question, undefined);
});

test('admission hardening: explicit uncertainty withdraws a confirmed value and invalidates its result', async () => {
  const store = fakeStore();
  const c = svc(store, [], async ({ payload, skillId }) => ({
    status: 'completed', skillId, skillVersion: 1, runId: 'run-unknown',
    ...((payload as { context: { duration_days?: unknown } }).context.duration_days === 6
      ? {
        answer: { text: 'Result', evidenceIds: ['chunk-grounded'] },
        trace: {
          decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['chunk-grounded'],
          materialFactKeys: ['duration_days'],
        },
      } : {}),
  }));
  const session = await c.create('p', 'a', 'contextual');
  await c.handleMessage('p', 'a', session.id, { text: '6', answers: [{ key: 'duration_days', value: 6 }] });
  const turn = await c.handleMessage('p', 'a', session.id, { text: "I don't know.", answers: [{ key: 'duration_days', value: 'UNKNOWN' }] });
  assert.equal(turn.caseState?.groundedResult, 'invalidated');
  assert.equal(store.rows.get(session.id)?.sessionContext.facts.duration_days, 'UNKNOWN');
});

test('admission hardening: an explicit structured withdrawal can clear a legacy confirmation', async () => {
  const store = fakeStore();
  const c = svc(store);
  const session = await c.create('p', 'a', 'contextual');
  const state = store.rows.get(session.id)!.sessionContext;
  state.facts.legacy_answer = '2026-11-01';
  state.factMeta = { legacy_answer: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } };

  await c.handleMessage('p', 'a', session.id, { text: 'Unknown', answers: [{ key: 'legacy_answer', value: "I don't know." }] });
  const after = store.rows.get(session.id)!.sessionContext;
  assert.equal(after.facts.legacy_answer, 'UNKNOWN');
  assert.equal(after.factMeta?.legacy_answer?.certainty, 'UNKNOWN');
});

test('admission hardening: skill proposals cannot overwrite app evidence or displace confirmed metadata', async () => {
  const store = fakeStore();
  const c = svc(store, [], async ({ skillId }) => ({
    status: 'completed', skillId, skillVersion: 1, runId: 'run-proposals',
    caseFacts: { observation: 'proposed', ...Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`proposal_${index}`, index])) },
  }));
  const session = await c.create('p', 'a', 'contextual');
  const turn = await c.handleMessage('p', 'a', session.id, {
    text: '6', answers: [{ key: 'duration_days', value: 6 }], appContext: { observation: 'app' },
  });
  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(turn.caseState?.facts.find((fact) => fact.key === 'observation')?.value, 'app');
  assert.equal(state.facts.observation, 'app');
  assert.equal(state.factMeta?.observation?.provenance, 'evidence');
  assert.equal(state.factMeta?.duration_days?.certainty, 'CERTAIN');
});

test('admission round 2: a declared duration blocks negative replacement of a legacy number', async () => {
  const store = fakeStore();
  const skillId = 'test.duration';
  const c = new ConversationService({
    persistence: store, understanding: new UnderstandingService(), defaultSkillId: skillId,
    skills: { async execute() { return { status: 'completed', skillId, skillVersion: 1, runId: 'duration' }; } },
    interactionsFor: () => ({ duration: { type: 'duration' } }),
  });
  const session = await c.create('p', 'a', 'contextual');
  const state = store.rows.get(session.id)!.sessionContext;
  state.facts.duration = 5;
  state.factMeta = { duration: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } };

  await c.handleMessage('p', 'a', session.id, { text: 'I meant -1' });
  assert.equal(store.rows.get(session.id)?.sessionContext.facts.duration, 5);
  await c.handleMessage('p', 'a', session.id, { text: 'I meant 6 days' });
  assert.equal(store.rows.get(session.id)?.sessionContext.facts.duration, '6 days');
});

test('admission round 2: a withdrawal cannot forward an unsigned stored result', async () => {
  const store = fakeStore();
  const seen: unknown[] = [];
  const c = svc(store, [], async ({ payload, skillId }) => {
    seen.push((payload as { lastGroundedResult?: unknown }).lastGroundedResult);
    return { status: 'completed', skillId, skillVersion: 1, runId: 'unsigned' };
  });
  const session = await c.create('p', 'a', 'contextual');
  const state = store.rows.get(session.id)!.sessionContext;
  state.facts.duration_days = 6;
  state.factMeta = { duration_days: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } };
  state.lastGroundedResult = { skillId: 'demo.conversation-eligibility', status: 'DECIDED', evidenceRefs: ['chunk'] };

  const turn = await c.handleMessage('p', 'a', session.id, { text: 'Unknown', answers: [{ key: 'duration_days', value: 'UNKNOWN' }] });
  assert.equal(seen[0], undefined);
  assert.equal(turn.caseState?.groundedResult, 'invalidated');
  assert.equal(store.rows.get(session.id)?.sessionContext.lastGroundedResult, undefined);
});

test('admission round 3: a pending answer at the fact cap is retained and can complete the turn', async () => {
  const store = fakeStore();
  const seen: Array<{ context: Record<string, unknown>; answeredKeys: string[] }> = [];
  const key = 'next_answer';
  const c = svc(store, [], async ({ payload, skillId }) => {
    const current = payload as (typeof seen)[number];
    seen.push(current);
    const result = readiness.evaluate({
      requirements: [{ key, description: 'Next fact', material: true, question: { key, wording: 'How many?' }, interaction: { type: 'number' } }],
      known: Object.entries(current.context).map(([key, value]) => ({ key, value, source: 'user' as const })),
    });
    return { status: 'completed', skillId, skillVersion: 1, runId: 'full-cap', readiness: result };
  });
  const session = await c.create('p', 'a', 'contextual');
  const state = store.rows.get(session.id)!.sessionContext;
  state.facts = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`old_${index}`, index]));
  state.factMeta = Object.fromEntries(Object.keys(state.facts).map((oldKey, index) => [oldKey, {
    provenance: 'user_answer', certainty: 'CERTAIN', at: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString(),
  }]));
  const first = await c.handleMessage('p', 'a', session.id, { text: 'Start' });
  assert.equal(first.status, 'needs_information');
  const completed = await c.handleMessage('p', 'a', session.id, { text: '6' });
  assert.equal(completed.readiness?.status, 'READY_FOR_DECISION');
  assert.deepEqual(seen[1].answeredKeys, [key]);
  assert.equal(seen[1].context[key], 6);
  const persisted = store.rows.get(session.id)!.sessionContext;
  assert.equal(persisted.facts[key], 6);
  assert.equal(persisted.factMeta?.[key]?.certainty, 'CERTAIN');
  assert.equal(persisted.facts.old_0, undefined);
  assert.equal(Object.keys(persisted.facts).length, 40);
  assert.equal(persisted.pendingKey, undefined);
  const retry = await c.handleMessage('p', 'a', session.id, { text: '6' });
  assert.equal(retry.readiness?.status, 'READY_FOR_DECISION');
});

test('skill-bound facts do not enter the session fact store', async () => {
  const store = fakeStore();
  const c = new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'en', issues: [text],
        references: { resolved: true }, corrections: [], facts: [], candidates: [], ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async () => ({
        status: 'completed', skillId: 'test.proposal', skillVersion: 1, runId: 'run-proposal',
        caseFacts: { duration_days: 6 },
      }),
    },
    defaultSkillId: 'test.proposal',
  });
  const session = await c.create('p', 'a', 'contextual');

  await c.handleMessage('p', 'a', session.id, { text: 'It lasted 6 days' });

  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(state.facts.duration_days, undefined);
  assert.equal(state.factMeta?.duration_days, undefined);
});

test('Understanding candidates reach skills as advisory observations, never certainty authority', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'en', issues: [text],
        references: { resolved: true }, corrections: [], facts: [], ambiguity: { material: false },
        candidates: [{
          kind: 'duration', value: 6, unit: 'day', originalText: '6 days', certainty: 'CERTAIN', provenance: 'user_statement',
        }],
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async ({ payload }) => {
        seen.push(payload as Record<string, unknown>);
        return { status: 'completed', skillId: 'test.observation', skillVersion: 1, runId: 'run-observation' };
      },
    },
    defaultSkillId: 'test.observation',
  });
  const session = await c.create('p', 'a', 'contextual');

  await c.handleMessage('p', 'a', session.id, { text: 'Could I wait 6 days' });

  const candidates = seen[0].statementFacts as Array<{ certainty: string }>;
  assert.equal(candidates[0].certainty, 'UNCERTAIN');
  assert.deepEqual(store.rows.get(session.id)!.sessionContext.facts, {});
});

/**
 * K25 seam: a skill that derives its requirements DYNAMICALLY (no static
 * readiness, no static interaction hints) must still reach the user as a real
 * question with the right control — the requirement carries its own interaction.
 */
test('dynamic requirement: the conversation renders the requirement-owned control and bounded trace', async () => {
  const store = fakeStore();
  const requirement: DecisionRequirement = {
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

const groundedSkillFake = (
  seen: Array<Record<string, unknown>>,
  skillId = 'naqaa.fiqh-hayd',
) => ({
  execute: async (input: { payload?: unknown }) => {
    seen.push((input.payload ?? {}) as Record<string, unknown>);
    return {
      status: 'completed' as const, skillId, skillVersion: 1, runId: 'run-g',
      answer: { text: 'هذا الدم ليس حيضًا.', sourceTitle: 'الحيض الالوكة', evidenceIds: ['chunk-7', 'chunk-8'], label: 'ليس حيضًا' },
      trace: { status: 'DECIDED' as const, decisionStatus: 'DECIDED' as const, decisionLabel: 'ليس حيضًا', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['chunk-7', 'chunk-8'], materialFactKeys: ['observed_duration_hours'] },
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
  const seeded = store.rows.get(sess.id)!.sessionContext;
  seeded.facts.observed_duration_hours = 6;
  seeded.factMeta = { observed_duration_hours: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } };
  const t1 = await c.handleMessage('p', 'a', sess.id, { text: 'نزل دم ٦ ساعات فقط. هل هو حيض؟' });
  assert.equal(t1.trace?.decisionStatus, 'DECIDED');
  const stored = store.rows.get(sess.id)!.sessionContext.lastGroundedResult;
  assert.ok(stored, 'the grounded result is kept in the session context');
  assert.equal(stored!.skillId, 'naqaa.fiqh-hayd');
  assert.equal(stored!.decision, 'ليس حيضًا');
  assert.equal(stored!.sourceTitle, 'الحيض الالوكة');
  assert.deepEqual(stored!.evidenceRefs, ['chunk-7', 'chunk-8']);
  assert.deepEqual(stored!.materialFactKeys, ['observed_duration_hours']);
  // the next turn receives it (so a follow-up can be answered from it)
  await c.handleMessage('p', 'a', sess.id, { text: 'شنو المصدر؟' });
  assert.ok(seen[1].lastGroundedResult, 'the bounded result is passed to the skill');
});

for (const malformed of [
  { name: 'omitted evidenceRefs', record: { materialFactKeys: ['observed_duration_hours'] } },
  { name: 'null evidenceRefs', record: { evidenceRefs: null, materialFactKeys: ['observed_duration_hours'] } },
  { name: 'scalar evidenceRefs', record: { evidenceRefs: 'chunk-7', materialFactKeys: ['observed_duration_hours'] } },
  { name: 'empty evidenceRefs', record: { evidenceRefs: [], materialFactKeys: ['observed_duration_hours'] } },
  { name: 'malformed evidence element', record: { evidenceRefs: ['chunk-7', 42], materialFactKeys: ['observed_duration_hours'] } },
  { name: 'null materialFactKeys', record: { evidenceRefs: ['chunk-7'], materialFactKeys: null } },
  { name: 'scalar materialFactKeys', record: { evidenceRefs: ['chunk-7'], materialFactKeys: 'observed_duration_hours' } },
  { name: 'malformed material fact element', record: { evidenceRefs: ['chunk-7'], materialFactKeys: ['observed_duration_hours', 42] } },
  { name: 'trailing whitespace skillId', record: { skillId: 'naqaa.fiqh-hayd-minimal ', evidenceRefs: ['chunk-7'], materialFactKeys: ['observed_duration_hours'] } },
  { name: 'leading whitespace skillId', record: { skillId: ' naqaa.fiqh-hayd-minimal', evidenceRefs: ['chunk-7'], materialFactKeys: ['observed_duration_hours'] } },
  { name: 'noncanonical skillId', record: { skillId: 'naqaa/fiqh-hayd-minimal', evidenceRefs: ['chunk-7'], materialFactKeys: ['observed_duration_hours'] } },
] as const) {
  test(`final malformed session: ${malformed.name} is invalidated without reaching the skill`, async () => {
    const store = fakeStore();
    const seen: unknown[] = [];
    let call = 0;
    const conversation = new ConversationService({
      persistence: store,
      understanding: understandingFake() as never,
      skills: { execute: async ({ payload }) => {
        seen.push((payload as { lastGroundedResult?: unknown }).lastGroundedResult);
        call += 1;
        if (call === 1) return groundedSkillFake([]).execute({ payload });
        return { status: 'completed', skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'malformed-session' } as never;
      } },
      defaultSkillId: 'naqaa.fiqh-hayd',
    });
    const session = await conversation.create('p', 'a', 'private');
    const context = store.rows.get(session.id)!.sessionContext;
    context.facts.observed_duration_hours = 6;
    context.factMeta = { observed_duration_hours: {
      certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z',
    } };
    await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
    const valid = store.rows.get(session.id)!.sessionContext.lastGroundedResult;
    assert.ok(valid);
    store.rows.get(session.id)!.sessionContext.lastGroundedResult = {
      skillId: 'naqaa.fiqh-hayd', status: 'DECIDED', decision: 'ليس حيضًا',
      caseSignature: valid.caseSignature,
      ...malformed.record,
    } as never;

    const response = await conversation.handleMessage('p', 'a', session.id, { text: 'ليش؟' });
    assert.equal(seen[1], undefined, 'malformed persisted JSON must not cross the skill boundary');
    assert.equal(response.caseState?.groundedResult, 'invalidated');
    assert.equal(response.caseState?.invalidationReason, 'grounded_dependency_proof_missing_or_invalid');
    assert.equal(store.rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);

    const retry = await conversation.handleMessage('p', 'a', session.id, { text: 'أعد التحقق.' });
    assert.equal(retry.status, 'completed');
    assert.equal(seen[2], undefined, 'the cleared malformed result must stay withheld on retry');
    assert.equal(store.rows.get(session.id)!.sessionContext.turnCount, 3);
  });
}

test('final persisted session: exact Minimal skillId replays unchanged', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const conversation = new ConversationService({
    persistence: store,
    understanding: understandingFake() as never,
    skills: groundedSkillFake(seen, 'naqaa.fiqh-hayd-minimal') as never,
    defaultSkillId: 'naqaa.fiqh-hayd-minimal',
  });
  const session = await conversation.create('p', 'a', 'private');
  const context = store.rows.get(session.id)!.sessionContext;
  context.facts.observed_duration_hours = 6;
  context.factMeta = { observed_duration_hours: {
    certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z',
  } };

  await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
  const original = structuredClone(store.rows.get(session.id)!.sessionContext.lastGroundedResult);
  assert.equal(original?.skillId, 'naqaa.fiqh-hayd-minimal');

  await conversation.handleMessage('p', 'a', session.id, { text: 'ليش؟' });
  assert.deepEqual(seen[1].lastGroundedResult, original);
  assert.equal((seen[1].lastGroundedResult as { skillId: string }).skillId, 'naqaa.fiqh-hayd-minimal');
});

for (const scenario of [
  { name: 'SOURCE_GAP', decisionStatus: 'SOURCE_GAP', sourceSupport: 'PARTIAL', materialFactKeys: ['onset'] },
  { name: 'INSUFFICIENT_EVIDENCE', decisionStatus: 'INSUFFICIENT_EVIDENCE', sourceSupport: 'UNSUPPORTED', materialFactKeys: ['onset'] },
  { name: 'unsupported personal answer', decisionStatus: 'ANSWER', sourceSupport: 'UNSUPPORTED', materialFactKeys: ['onset'] },
  { name: 'personal answer without evidence', decisionStatus: 'ANSWER', sourceSupport: 'SUPPORTED', materialFactKeys: ['onset'], noEvidence: true },
  { name: 'missing dependency proof', decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', materialFactKeys: undefined },
  { name: 'empty dependency proof', decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', materialFactKeys: [] },
  { name: 'duplicate dependency proof', decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', materialFactKeys: ['onset', 'onset'] },
  { name: 'unknown dependency', decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', materialFactKeys: ['missing'] },
  { name: 'padded dependency', decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', materialFactKeys: [' onset'] },
  { name: 'uncertain dependency', decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', materialFactKeys: ['onset'], certainty: 'UNCERTAIN' },
  { name: 'non-answer dependency', decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', materialFactKeys: ['onset'], provenance: 'memory' },
] as const) {
  test(`final fiqh fix round 1: Conversation does not persist ${scenario.name} as grounded`, async () => {
    const store = fakeStore();
    const conversation = new ConversationService({
      persistence: store,
      understanding: understandingFake() as never,
      skills: { execute: async () => ({
        status: 'completed', skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'round-1',
        answer: {
          text: 'نص غير قابل لإعادة الاستخدام.',
          ...(!('noEvidence' in scenario) ? { evidenceIds: ['chunk-7'] } : {}),
          label: 'hayd',
        },
        trace: {
          status: scenario.decisionStatus, decisionStatus: scenario.decisionStatus,
          sourceSupport: scenario.sourceSupport,
          ...(!('noEvidence' in scenario) ? { acceptedEvidenceRefs: ['chunk-7'] } : {}),
          ...(scenario.materialFactKeys !== undefined ? { materialFactKeys: scenario.materialFactKeys } : {}),
        },
      }) as never },
      defaultSkillId: 'naqaa.fiqh-hayd',
    });
    const session = await conversation.create('p', 'a', 'private');
    const context = store.rows.get(session.id)!.sessionContext;
    context.facts.onset = 'أمس';
    context.factMeta = { onset: {
      certainty: ('certainty' in scenario ? scenario.certainty : undefined) ?? 'CERTAIN',
      provenance: ('provenance' in scenario ? scenario.provenance : undefined) ?? 'user_answer',
      at: '2026-11-01T00:00:00.000Z',
    } };
    const response = await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
    assert.equal(store.rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
    assert.equal(response.caseState?.groundedResult, 'none');
  });
}

for (const refusal of [
  { name: 'control SOURCE_GAP', skillId: 'naqaa.fiqh-hayd', decisionStatus: 'SOURCE_GAP', status: 'SOURCE_GAP', sourceSupport: 'PARTIAL', keys: ['observed_duration_hours'], evidence: ['chunk-7'] },
  { name: 'Minimal INSUFFICIENT_EVIDENCE', skillId: 'naqaa.fiqh-hayd-minimal', decisionStatus: 'INSUFFICIENT_EVIDENCE', status: 'INSUFFICIENT_EVIDENCE', sourceSupport: 'UNSUPPORTED', keys: ['observed_duration_hours'], evidence: ['chunk-7'] },
  { name: 'Mind INSUFFICIENT_EVIDENCE', skillId: 'naqaa.fiqh-hayd-mind', decisionStatus: 'INSUFFICIENT_EVIDENCE', status: 'INSUFFICIENT_EVIDENCE', sourceSupport: 'UNSUPPORTED', keys: ['observed_duration_hours'], evidence: ['chunk-7'] },
  { name: 'unsupported answer', skillId: 'naqaa.fiqh-hayd', decisionStatus: 'ANSWER', status: 'ANSWER', sourceSupport: 'UNSUPPORTED', keys: ['observed_duration_hours'], evidence: ['chunk-7'] },
  { name: 'dependency rejection', skillId: 'naqaa.fiqh-hayd-minimal', decisionStatus: 'DECIDED', status: 'SOURCE_GAP', sourceSupport: 'SUPPORTED', keys: [], evidence: ['chunk-7'] },
  { name: 'invalid citation', skillId: 'naqaa.fiqh-hayd-mind', decisionStatus: 'DECIDED', status: 'SOURCE_GAP', sourceSupport: 'SUPPORTED', keys: ['observed_duration_hours'], evidence: [] },
] as const) {
  test(`final state transition: ${refusal.name} clears an older grounded result`, async () => {
    const store = fakeStore();
    const seen: Array<Record<string, unknown>> = [];
    let call = 0;
    const conversation = new ConversationService({
      persistence: store,
      understanding: understandingFake() as never,
      skills: { execute: async ({ payload }) => {
        seen.push(payload as Record<string, unknown>);
        call += 1;
        if (call === 1) return groundedSkillFake([], refusal.skillId).execute({ payload });
        if (call === 2) return {
          status: 'completed', skillId: refusal.skillId, skillVersion: 1, runId: `refusal-${refusal.name}`,
          answer: { text: 'الدليل المتاح غير كافٍ للإجابة.' },
          trace: {
            status: refusal.status, decisionStatus: refusal.decisionStatus, sourceSupport: refusal.sourceSupport,
            acceptedEvidenceRefs: refusal.evidence, materialFactKeys: refusal.keys,
          },
        } as never;
        return { status: 'completed', skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'after-refusal' } as never;
      } },
      defaultSkillId: refusal.skillId,
    });
    const session = await conversation.create('p', 'a', 'private');
    const context = store.rows.get(session.id)!.sessionContext;
    context.facts.observed_duration_hours = 6;
    context.factMeta = { observed_duration_hours: {
      certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z',
    } };
    await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
    assert.ok(store.rows.get(session.id)!.sessionContext.lastGroundedResult);

    const rejected = await conversation.handleMessage('p', 'a', session.id, { text: 'أعد التحقق.' });
    assert.equal(store.rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
    assert.equal(rejected.caseState?.groundedResult, 'invalidated');
    assert.equal(rejected.caseState?.invalidationReason, 'terminal_result_not_grounded');

    await conversation.handleMessage('p', 'a', session.id, { text: 'ليش؟' });
    assert.equal(seen[2].lastGroundedResult, undefined, 'the older ruling cannot replay after refusal');
  });
}

test('final state transition: genuine grounded reuse keeps the original stored result unchanged', async () => {
  const store = fakeStore();
  let call = 0;
  const conversation = new ConversationService({
    persistence: store,
    understanding: understandingFake() as never,
    skills: { execute: async ({ payload }) => {
      call += 1;
      if (call === 1) return groundedSkillFake([]).execute({ payload });
      return {
        status: 'completed', skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'reused',
        answer: { text: 'المصدر المعتمد: «الحيض الالوكة».', evidenceIds: ['chunk-7', 'chunk-8'], label: 'ليس حيضًا' },
        trace: {
          status: 'FOLLOWUP_SOURCE', decisionStatus: 'DECIDED', decisionLabel: 'ليس حيضًا',
          sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['chunk-7', 'chunk-8'],
          materialFactKeys: ['observed_duration_hours'], reusedGroundedResult: true,
        },
      } as never;
    } },
    defaultSkillId: 'naqaa.fiqh-hayd',
  });
  const session = await conversation.create('p', 'a', 'private');
  const context = store.rows.get(session.id)!.sessionContext;
  context.facts.observed_duration_hours = 6;
  context.factMeta = { observed_duration_hours: {
    certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z',
  } };
  await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
  const original = structuredClone(store.rows.get(session.id)!.sessionContext.lastGroundedResult);
  const response = await conversation.handleMessage('p', 'a', session.id, { text: 'شنو المصدر؟' });
  assert.deepEqual(response.trace?.materialFactKeys, ['observed_duration_hours']);
  assert.equal((response.trace as Record<string, unknown>)?.reusedGroundedResult, true);
  assert.deepEqual(store.rows.get(session.id)!.sessionContext.lastGroundedResult, original);
  assert.equal(response.caseState?.groundedResult, 'valid');
});

test('a material correction CLEARS the stored grounded result before answering', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = new ConversationService({
    persistence: store,
    understanding: new UnderstandingService(),
    skills: groundedSkillFake(seen) as never,
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
    defaultSkillId: 'naqaa.fiqh-hayd',
  });
  const sess = await c.create('p', 'a', 'contextual');
  const stored = store.rows.get(sess.id)!.sessionContext;
  stored.facts.observed_duration_hours = 6;
  stored.factMeta = { observed_duration_hours: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } };
  await c.handleMessage('p', 'a', sess.id, { text: 'نزل دم ٦ ساعات فقط. هل هو حيض؟' });
  assert.ok(store.rows.get(sess.id)!.sessionContext.lastGroundedResult, 'stored first');
  // a correction arrives while the stored result exists
  await c.handleMessage('p', 'a', sess.id, { text: 'لا، قصدي 24' });
  assert.deepEqual(seen[1].context, { observed_duration_hours: 24 });
  assert.equal(store.rows.get(sess.id)!.sessionContext.factMeta?.observed_duration_hours.superseded?.[0]?.value, '6');
  assert.equal(seen[1].lastGroundedResult, undefined, 'the stale result is NOT handed to the skill');
  // the corrected turn reasons again from the updated facts; whatever it stores is a
  // NEW result for the NEW case, never the previous decision reused as authority.
  assert.equal(store.rows.get(sess.id)!.sessionContext.turnCount, 2);
  assert.equal(seen[1].lastGroundedResult, undefined);
});

test('a non-pending date correction replaces the uniquely matching session fact', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = new ConversationService({
    persistence: store,
    understanding: new UnderstandingService(),
    skills: {
      execute: async ({ payload }) => {
        seen.push(payload as Record<string, unknown>);
        return { status: 'completed', skillId: 'test.correction', skillVersion: 1, runId: 'run-correction' };
      },
    },
    defaultSkillId: 'test.correction',
  });
  const session = await c.create('p', 'a', 'contextual');
  const seeded = store.rows.get(session.id)!;
  seeded.sessionContext = {
    facts: { last_bleeding_start: '2026-11-01' },
    factMeta: { last_bleeding_start: {
      provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z',
      admission: { skillId: 'test.correction', interaction: { type: 'date' } },
    } },
    turnCount: 1,
    recentTurns: [],
    lastGroundedResult: {
      skillId: 'test.correction', status: 'DECIDED', evidenceRefs: ['chunk-1'], caseSignature: 'old-signature',
    },
  };

  await c.handleMessage('p', 'a', session.id, { text: 'لا، قصدي 2026-11-02' });

  assert.equal(store.rows.get(session.id)!.sessionContext.facts.last_bleeding_start, '2026-11-02');
  assert.equal(seen[0].lastGroundedResult, undefined, 'the stale result is not handed to the skill');
});
