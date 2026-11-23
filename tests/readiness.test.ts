/**
 * K22 Decision Readiness — generic gate tests (deterministic; no model).
 * Live API + Memory + isolation are proven in scripts/_k22readiness.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import type { DecisionRequirement, KnownContextItem } from '../src/core/readiness/readiness.ts';
import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { decisionReadinessFixture } from '../src/core/skill/decision-readiness-fixture.ts';
import type { RunRecord } from '../src/core/runtime/runtime.ports.ts';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';

const svc = new DecisionReadinessService();
const reqs: DecisionRequirement[] = [
  { key: 'prior_complete_days', description: 'complete days before event', material: true, question: { key: 'prior_complete_days', wording: 'كم يوماً كاملاً مرّ قبل بدء هذا الحدث؟' } },
  { key: 'optional_note', description: 'optional', material: false },
];
const known = (items: Array<[string, unknown]>): KnownContextItem[] => items.map(([key, value]) => ({ key, value, source: 'user' }));

for (const value of [[], ['  '], ['UNKNOWN'], 'UNKNOWN', '  ', ['valid', ' '], ['valid', 'غير متأكدة']]) {
  test(`canonical readiness rejects empty or unknown value ${JSON.stringify(value)}`, () => {
    assert.equal(svc.evaluate({ requirements: reqs, known: known([['prior_complete_days', value]]) }).status, 'NEEDS_INFORMATION');
  });
}

for (const value of [false, 0, '2026-11-02', ['valid']]) {
  test(`canonical readiness preserves present value ${JSON.stringify(value)}`, () => {
    assert.equal(svc.evaluate({ requirements: reqs, known: known([['prior_complete_days', value]]) }).status, 'READY_FOR_DECISION');
  });
}

test('A clear but insufficient -> NEEDS_INFORMATION', () => {
  const r = svc.evaluate({ requirements: reqs, known: [] });
  assert.equal(r.status, 'NEEDS_INFORMATION');
});

test('B missing material field -> exact missing item', () => {
  const r = svc.evaluate({ requirements: reqs, known: [] });
  assert.deepEqual(r.missing.map((m) => m.key), ['prior_complete_days']);
});

test('C known context satisfies -> not missing (no duplicate question)', () => {
  const r = svc.evaluate({ requirements: reqs, known: known([['prior_complete_days', 6]]) });
  assert.equal(r.status, 'READY_FOR_DECISION');
  assert.equal(r.missing.length, 0);
  assert.deepEqual(r.satisfied, ['prior_complete_days']);
});

test('D missing non-material does NOT block', () => {
  const r = svc.evaluate({ requirements: reqs, known: known([['prior_complete_days', 3]]) });
  assert.equal(r.status, 'READY_FOR_DECISION'); // optional_note missing but non-material
});

test('E question semantics separate from internal requirement', () => {
  const r = svc.evaluate({ requirements: reqs, known: [] });
  assert.equal(r.nextQuestion?.key, 'prior_complete_days'); // key preserved
  assert.notEqual(r.nextQuestion?.wording, r.missing[0].description); // wording != internal description
});

test('F question simple / non-jurisprudential / one need', () => {
  const r = svc.evaluate({ requirements: reqs, known: [] });
  const q = r.nextQuestion!.wording;
  assert.equal(/hayd|istihada|nifas|purity|طهارة|حيض|استحاضة|نفاس|حكم|يجوز|حرام/.test(q), false);
  assert.ok(q.length > 0 && r.missing.length === 1);
});

test('G supplying the answer recomputes to READY', () => {
  const first = svc.evaluate({ requirements: reqs, known: [] });
  assert.equal(first.status, 'NEEDS_INFORMATION');
  const after = svc.evaluate({ requirements: reqs, known: known([[first.nextQuestion!.key, '7']]) });
  assert.equal(after.status, 'READY_FOR_DECISION');
});

test('H multiple material gaps -> one deterministic next question', () => {
  const multi: DecisionRequirement[] = [
    { key: 'a', description: 'A', material: true, question: { key: 'a', wording: 'سؤال أ؟' } },
    { key: 'b', description: 'B', material: true, question: { key: 'b', wording: 'سؤال ب؟' } },
  ];
  const r1 = svc.evaluate({ requirements: multi, known: [] });
  const r2 = svc.evaluate({ requirements: multi, known: [] });
  assert.equal(r1.nextQuestion?.key, 'a');
  assert.equal(r2.nextQuestion?.key, 'a'); // deterministic
  assert.equal(r1.missing.length, 2);        // reports all, asks one
});

test('I reaching the UX target does NOT force READY', () => {
  const r = svc.evaluate({ requirements: reqs, known: [], questionsAsked: 9, targetQuestions: 5 });
  assert.equal(r.status, 'NEEDS_INFORMATION'); // still not READY
});

test('J unaskable material gap -> INSUFFICIENT_CONTEXT (blocks)', () => {
  const noQuestion: DecisionRequirement[] = [{ key: 'from_provider', description: 'needs a provider', material: true }];
  const r = svc.evaluate({ requirements: noQuestion, known: [] });
  assert.equal(r.status, 'INSUFFICIENT_CONTEXT');
});

test('O no domain/fiqh concepts in the generic service', () => {
  const r = svc.evaluate({ requirements: reqs, known: [] });
  assert.equal(/hayd|istihada|nifas|purity|prayer|fasting/i.test(JSON.stringify(r)), false);
});

test('P no model call for readiness/quotation (deterministic)', () => {
  // The service is pure; evaluate is synchronous and touches no gateway.
  const r = svc.evaluate({ requirements: reqs, known: [] });
  assert.equal(typeof r.status, 'string');
});

// ---- runtime gate integration (code-level boundary) ----
function fakePersistence() {
  const runs: Record<string, RunRecord> = {};
  return {
    runs,
    async getProject(id: string) { return id === 'p' ? { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' } : null; },
    async getMembership(projectId: string, actor: string) { return { projectId, actor, role: 'owner' as const, createdAt: '' }; },
    async createRun(run: RunRecord) { runs[run.id] = run; },
    async updateRun(id: string, patch: Partial<RunRecord>) { runs[id] = { ...(runs[id] ?? { id }), ...patch } as RunRecord; },
  };
}
const rt = (memory: Array<{ memoryKey: string; value: unknown }> = []) => {
  const reg = new MapSkillRegistry(); reg.register(decisionReadinessFixture);
  return new SkillsRuntime({
    persistence: fakePersistence(), registry: reg, readiness: svc,
    memory: { fetchBounded: async () => ({ user: memory.map((m) => ({ id: 'm', scope: 'user', memoryType: 'preference', memoryKey: m.memoryKey, payload: { value: m.value } })), conversation: [], case: [] }) },
  });
};

test('J(runtime) not-ready BLOCKS the skill body; K(runtime) ready ALLOWS it', async () => {
  let bodyRan = 0;
  const reg = new MapSkillRegistry();
  reg.register({ ...decisionReadinessFixture, execute: async (ctx) => { bodyRan++; return { decisionAllowed: true, readiness: ctx.readiness?.status }; } });
  const runtime = new SkillsRuntime({
    persistence: fakePersistence(), registry: reg, readiness: svc,
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
  });

  const blocked = await runtime.execute({ projectId: 'p', actor: 'a', skillId: 'demo.decision-readiness', payload: {} });
  assert.equal(blocked.status, 'needs_information');
  assert.equal(blocked.readiness?.status, 'NEEDS_INFORMATION');
  assert.equal(bodyRan, 0); // body did NOT run

  const allowed = await runtime.execute({ projectId: 'p', actor: 'a', skillId: 'demo.decision-readiness', payload: {
    context: { prior_complete_days: 6 }, factMeta: { prior_complete_days: { provenance: 'user_answer', certainty: 'CERTAIN' } },
  } });
  assert.equal(allowed.status, 'completed');
  assert.equal(allowed.readiness?.status, 'READY_FOR_DECISION');
  assert.equal(bodyRan, 1); // body ran exactly once (on the ready path)
});

test('C(bounded memory) memory is CONTEXT only: it never closes a material need across the runtime', async () => {
  // B1.1/K-6: a memory-derived value is not a user assertion — the platform's existing certainty
  // convention is UNCERTAIN, so it must NOT satisfy a material requirement...
  const runtime = rt([{ memoryKey: 'prior_complete_days', value: 4 }]);
  const r = await runtime.execute({ projectId: 'p', actor: 'a', skillId: 'demo.decision-readiness', payload: {} });
  assert.equal(r.status, 'needs_information');
  assert.equal(r.readiness?.status, 'NEEDS_INFORMATION');
  // ...whereas a value supplied FOR THIS CASE does satisfy it.
  const withContext = await runtime.execute({ projectId: 'p', actor: 'a', skillId: 'demo.decision-readiness', payload: {
    context: { prior_complete_days: 4 }, factMeta: { prior_complete_days: { provenance: 'user_answer', certainty: 'CERTAIN' } },
  } });
  assert.equal(withContext.status, 'completed');
  assert.equal(withContext.readiness?.status, 'READY_FOR_DECISION');
});

for (const [name, meta] of [
  ['missing fact metadata', undefined],
  ['uncertain user answer', { provenance: 'user_answer', certainty: 'UNCERTAIN' }],
  ['app evidence', { provenance: 'evidence', certainty: 'UNCERTAIN' }],
  ['memory', { provenance: 'memory', certainty: 'UNCERTAIN' }],
  ['advisory statement', { provenance: 'user_statement', certainty: 'CERTAIN' }],
] as const) {
  test(`admission hardening: static skill readiness rejects ${name}`, async () => {
    const result = await rt().execute({
      projectId: 'p', actor: 'a', skillId: decisionReadinessFixture.id,
      payload: { context: { prior_complete_days: 6 }, ...(meta ? { factMeta: { prior_complete_days: meta } } : {}) },
    });
    assert.equal(result.readiness?.status, 'NEEDS_INFORMATION');
    assert.equal(result.status, 'needs_information');
  });
}

test('admission round 2: static readiness revalidates a value after changing skills', async () => {
  const key = 'observation';
  const registry = new MapSkillRegistry();
  for (const type of ['free_text', 'date'] as const) {
    registry.register({
      ...decisionReadinessFixture,
      id: type,
      requirements: { ...decisionReadinessFixture.requirements, memory: false },
      readiness: { requirements: [{
        key, material: true, description: 'Observation', question: { key, wording: 'What did you observe?' }, interaction: { type },
      }] },
    });
  }
  const sessions = new Map<string, ConversationSession>();
  const conversation = new ConversationService({
    persistence: {
      async create(session) { sessions.set(session.id, session); return session; },
      async get(_project, _actor, id) { return sessions.get(id) ?? null; },
      async save(session) { sessions.set(session.id, session); return session; },
    },
    understanding: new UnderstandingService(), defaultSkillId: 'free_text',
    skills: new SkillsRuntime({ persistence: fakePersistence(), registry, readiness: svc }),
  });
  const session = await conversation.create('p', 'a', 'private');
  await conversation.handleMessage('p', 'a', session.id, { text: 'Start' });
  const description = await conversation.handleMessage('p', 'a', session.id, { text: 'an ordinary note', answers: [{ key, value: 'an ordinary note' }] });
  assert.equal(description.readiness?.status, 'READY_FOR_DECISION');

  const needsDate = await conversation.handleMessage('p', 'a', session.id, { skillId: 'date', text: 'Continue' });
  assert.equal(needsDate.readiness?.status, 'NEEDS_INFORMATION');
  assert.equal(needsDate.interaction?.type, 'date');
  const hasDate = await conversation.handleMessage('p', 'a', session.id, { skillId: 'date', text: '2026-11-01' });
  assert.equal(hasDate.readiness?.status, 'READY_FOR_DECISION');
});

test('K25: a requirement-owned interaction hint is carried into the missing item', () => {
  const withControl: DecisionRequirement[] = [{
    key: 'bleeding_stopped', description: 'شرط الاتصال', material: true,
    question: { key: 'bleeding_stopped', wording: 'هل توقف الدم قبل هذا السائل؟' },
    interaction: { type: 'single_choice', options: ['توقف', 'كان ينزل'] },
  }];
  const r = svc.evaluate({ requirements: withControl, known: [] });
  assert.equal(r.status, 'NEEDS_INFORMATION');
  assert.equal(r.missing[0].interaction?.type, 'single_choice');
  assert.deepEqual(r.missing[0].interaction?.options, ['توقف', 'كان ينزل']);
  assert.equal(r.missing[0].question?.wording, 'هل توقف الدم قبل هذا السائل؟');
});
