/**
 * appContext STATE-FACT SYNC — deterministic acceptance suite.
 *
 * A request that carries an `appContext` object is the CURRENT complete snapshot of APP-ORIGIN
 * facts: those facts refresh through the normal fact-write path and are retracted when the key is
 * gone. Stronger/other facts (user answer, user statement, memory, skill-bound, no-metadata) are
 * never overwritten or removed by app context. A request with NO appContext field changes nothing.
 * Real ConversationService + real UnderstandingService; only the skill/store/memory are scripted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import { policyFor, type ConversationSession } from '../src/core/conversation/conversation.ts';

const understanding = new UnderstandingService();

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
    async save(s: ConversationSession) { rows.set(s.id, s); return s; },
  };
}

type SkillScript = (payload: Record<string, any>, call: number) => Record<string, unknown>;
const plain = (): Record<string, unknown> => ({ status: 'completed', skillId: 's', skillVersion: 1, runId: 'r', answer: { text: 'ok' } });
const grounded = (): Record<string, unknown> => ({
  status: 'completed', skillId: 's', skillVersion: 1, runId: 'r',
  answer: { text: 'ruling' }, trace: { decisionStatus: 'DECIDED', decisionLabel: 'hayd' },
});

function make(opts: {
  script?: SkillScript;
  memory?: Array<{ memoryKey: string; value: unknown }>;
  interactions?: Record<string, { type: string; options?: string[] }>;
} = {}) {
  const store = fakeStore();
  const seen: Array<Record<string, any>> = [];
  const memoryCalls: string[] = [];
  const memoryItems = opts.memory ?? [];
  const memory = new Proxy({
    fetchBounded: async () => ({
      user: memoryItems.map((m) => ({ id: 'm', scope: 'user', memoryType: 'p', memoryKey: m.memoryKey, payload: { value: m.value } })),
      conversation: [], case: [],
    }),
  } as Record<string, unknown>, { get(t, p) { memoryCalls.push(String(p)); return t[p as string]; } });
  let call = 0;
  const skills = {
    execute: async (input: { payload?: unknown }) => {
      const payload = (input.payload ?? {}) as Record<string, any>;
      seen.push(payload);
      return (opts.script ?? plain)(payload, ++call);
    },
  };
  const svc = new ConversationService({
    persistence: store as never,
    understanding: understanding as never,
    skills: skills as never,
    memory: memory as never,
    defaultSkillId: 's',
    interactionsFor: () => (opts.interactions ?? {}) as never,
  } as never);
  const sc = (id: string) => store.rows.get(id)!.sessionContext;
  return { svc, store, seen, memoryCalls, sc };
}

const msg = (text: string, appContext?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ text, ...(appContext !== undefined ? { appContext } : {}), ...extra }) as never;
const tick = () => new Promise((r) => setTimeout(r, 6));
const CHOICE = { current_state: { type: 'single_choice', options: ['hayd', 'tuhr'] } };

// ------------------------------------------------------------------ UPDATE --
test('1/2. an app-origin fact is UPDATED by a later snapshot — the first app value no longer wins forever', async () => {
  const { svc, sc, seen } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'tuhr', duration_hours: 80 }));
  assert.equal(sc(s.id).facts.current_state, 'tuhr');
  assert.equal(sc(s.id).facts.duration_hours, 80);
  assert.equal(seen[1].context.current_state, 'tuhr', 'the skill reasons over the refreshed value');
  assert.equal(seen[1].context.duration_hours, 80);
});

test('3. the update goes through the existing fact-write path: supersession trace + new timestamp + app origin', async () => {
  const { svc, sc } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd' }));
  const before = sc(s.id).factMeta!.current_state;
  assert.equal(before.origin, 'app');
  assert.equal(before.provenance, 'evidence');
  assert.equal(before.certainty, 'UNCERTAIN');
  assert.equal(before.superseded, undefined);
  await tick();
  await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'tuhr' }));
  const after = sc(s.id).factMeta!.current_state;
  assert.equal(after.superseded?.length, 1, 'existing supersession trace recorded');
  assert.notEqual(after.at, before.at, 'metadata timestamp advanced');
  assert.equal(after.origin, 'app');
  assert.equal(after.provenance, 'evidence');
  assert.equal(after.certainty, 'UNCERTAIN', 'app context never becomes certain');
});

test('3b. an idempotent re-send changes nothing (no churn, no fake supersession)', async () => {
  const { svc, sc } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  const m1 = JSON.stringify(sc(s.id).factMeta);
  await tick();
  await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'hayd', duration_hours: 72 }));
  assert.equal(JSON.stringify(sc(s.id).factMeta), m1);
});

// ------------------------------------------------------- STRONGER PROTECTION --
test('4. a user_answer (CERTAIN) is NOT overwritten by a later appContext', async () => {
  const { svc, sc } = make({ interactions: CHOICE });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd' }));
  await svc.handleMessage('p', 'u', s.id, msg('تصحيح', undefined, { answers: [{ key: 'current_state', value: 'tuhr' }] }));
  assert.equal(sc(s.id).facts.current_state, 'tuhr');
  assert.equal(sc(s.id).factMeta!.current_state.provenance, 'user_answer');
  assert.equal(sc(s.id).factMeta!.current_state.certainty, 'CERTAIN');
  assert.equal(sc(s.id).factMeta!.current_state.origin, undefined, 'a stronger write drops the app marker');
  await svc.handleMessage('p', 'u', s.id, msg('q3', { current_state: 'hayd' }));
  assert.equal(sc(s.id).facts.current_state, 'tuhr', 'the confirmed fact stays authoritative');
  assert.equal(sc(s.id).factMeta!.current_state.provenance, 'user_answer');
});

test('5. a CERTAIN user_statement bound by the skill is protected from appContext', async () => {
  const { svc, sc } = make({ script: (_p, call) => (call === 1 ? { ...plain(), caseFacts: { current_state: 'tuhr' } } : plain()) });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd' }));
  assert.equal(sc(s.id).facts.current_state, 'tuhr', 'the stronger skill-bound fact superseded the app evidence');
  assert.equal(sc(s.id).factMeta!.current_state.certainty, 'CERTAIN');
  await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'hayd' }));
  assert.equal(sc(s.id).facts.current_state, 'tuhr');
  assert.equal(sc(s.id).factMeta!.current_state.provenance, 'user_statement');
});

test('5b. a memory fact is not overwritten by app evidence (unchanged behaviour)', async () => {
  const { svc, sc } = make({ memory: [{ memoryKey: 'madhab', value: 'الشافعي' }] });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1'));
  assert.equal(sc(s.id).factMeta!.madhab.provenance, 'memory');
  await svc.handleMessage('p', 'u', s.id, msg('q2', { madhab: 'الحنفي' }));
  assert.equal(sc(s.id).facts.madhab, 'الشافعي');
});

// ------------------------------------------------------------------- DELETE --
test('6. an app-origin key missing from a new snapshot is REMOVED (deletion example)', async () => {
  const { svc, sc, seen } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await svc.handleMessage('p', 'u', s.id, msg('q2', { duration_hours: 80 }));
  assert.equal(sc(s.id).facts.current_state, undefined, 'retracted from the facts');
  assert.equal(sc(s.id).factMeta!.current_state, undefined, 'and from the metadata');
  assert.equal(sc(s.id).facts.duration_hours, 80, 'the other key updated');
  assert.equal(seen[1].context.current_state, undefined, 'the skill no longer sees the deleted fact');
  assert.equal(seen[1].factMeta.current_state, undefined);
  assert.ok(seen[1].changedFactKeys.includes('current_state'), 'a removal counts as a changed fact (B3a reuse-invalidation input)');
  assert.ok(seen[1].changedFactKeys.includes('duration_hours'));
  assert.ok(!seen[1].answeredKeys.includes('current_state'), 'a removed app fact is never an answered key');
});

test('6c. an idempotent re-send reports NO changed keys', async () => {
  const { svc, seen } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'hayd', duration_hours: 72 }));
  assert.deepEqual(seen[1].changedFactKeys, []);
});

test('6b. an empty snapshot object retracts every app-origin fact; a null/blank value counts as absent', async () => {
  const a = make();
  const s1 = await a.svc.create('p', 'u', 'contextual');
  await a.svc.handleMessage('p', 'u', s1.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await a.svc.handleMessage('p', 'u', s1.id, msg('q2', {}));
  assert.deepEqual(Object.keys(a.sc(s1.id).facts), []);
  const b = make();
  const s2 = await b.svc.create('p', 'u', 'contextual');
  await b.svc.handleMessage('p', 'u', s2.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await b.svc.handleMessage('p', 'u', s2.id, msg('q2', { current_state: null, duration_hours: '  ' } as never));
  assert.deepEqual(Object.keys(b.sc(s2.id).facts), []);
});

test('7. a request with NO appContext field does NOT remove app-origin facts', async () => {
  const { svc, sc, seen } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await svc.handleMessage('p', 'u', s.id, msg('q2'));
  assert.equal(sc(s.id).facts.current_state, 'hayd');
  assert.equal(sc(s.id).facts.duration_hours, 72);
  assert.equal(seen[1].context.current_state, 'hayd');
});

test('8. a user_answer is NOT removed by app snapshot omission', async () => {
  const { svc, sc } = make({ interactions: CHOICE });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd' }));
  await svc.handleMessage('p', 'u', s.id, msg('تصحيح', undefined, { answers: [{ key: 'current_state', value: 'tuhr' }] }));
  await svc.handleMessage('p', 'u', s.id, msg('q3', { duration_hours: 80 })); // current_state omitted
  assert.equal(sc(s.id).facts.current_state, 'tuhr');
  assert.equal(sc(s.id).factMeta!.current_state.provenance, 'user_answer');
});

test('9. a user_statement is NOT removed by app snapshot omission', async () => {
  const { svc, sc } = make({ script: (_p, call) => (call === 1 ? { ...plain(), caseFacts: { current_state: 'tuhr' } } : plain()) });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd' }));
  await svc.handleMessage('p', 'u', s.id, msg('q2', { duration_hours: 80 }));
  assert.equal(sc(s.id).facts.current_state, 'tuhr');
  assert.equal(sc(s.id).factMeta!.current_state.provenance, 'user_statement');
});

test('10. a memory fact is NOT removed by app snapshot omission', async () => {
  const { svc, sc } = make({ memory: [{ memoryKey: 'madhab', value: 'الشافعي' }] });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { duration_hours: 72 }));
  await svc.handleMessage('p', 'u', s.id, msg('q2', { is_pregnant: false }));
  assert.equal(sc(s.id).facts.madhab, 'الشافعي');
  assert.equal(sc(s.id).facts.duration_hours, undefined, 'while the app-origin fact WAS retracted');
});

test('11. several app keys update / remove / stay independently', async () => {
  const { svc, sc } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { a: 1, b: 2, c: 3 }));
  await tick();
  await svc.handleMessage('p', 'u', s.id, msg('q2', { a: 10, c: 3, d: 4 }));
  const f = sc(s.id).facts;
  assert.equal(f.a, 10);
  assert.equal(f.b, undefined);
  assert.equal(f.c, 3);
  assert.equal(f.d, 4);
  assert.equal(sc(s.id).factMeta!.a.superseded?.length, 1);
  assert.equal(sc(s.id).factMeta!.c.superseded, undefined, 'the unchanged key was not touched');
});

// ------------------------------------------------------------- COMPANION KEYS --
for (const [key, v1, v2] of [
  ['current_state_since', '2026-10-05T08:00:00.000Z', '2026-10-05T19:00:00.000Z'],
  ['current_state_source', 'manual', 'scanner'],
  ['current_state_confirmed', true, false],
] as const) {
  test(`12-14. companion key ${key} updates and retracts like any app fact`, async () => {
    const { svc, sc } = make();
    const s = await svc.create('p', 'u', 'contextual');
    await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', [key]: v1 }));
    assert.equal(sc(s.id).facts[key], v1);
    assert.equal(sc(s.id).factMeta![key].origin, 'app');
    await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'hayd', [key]: v2 }));
    assert.equal(sc(s.id).facts[key], v2, 'updated normally');
    await svc.handleMessage('p', 'u', s.id, msg('q3', { current_state: 'hayd' }));
    assert.equal(sc(s.id).facts[key], undefined, 'retracted when absent');
    assert.equal(sc(s.id).facts.current_state, 'hayd');
  });
}

// ------------------------------------------------------------- INVALIDATION --
test('15. an app fact UPDATE or REMOVAL invalidates a previously grounded result (existing signature logic)', async () => {
  for (const [label, second] of [
    ['update', { current_state: 'tuhr' }],
    ['removal', { duration_hours: 72 }],
  ] as const) {
    const { svc, seen } = make({ script: (_p, call) => (call === 1 ? grounded() : plain()) });
    const s = await svc.create('p', 'u', 'contextual');
    await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
    const r = await svc.handleMessage('p', 'u', s.id, msg('q2', second));
    assert.equal(r.caseState?.groundedResult, 'invalidated', label);
    assert.equal(r.caseState?.invalidationReason, 'material_fact_changed', label);
    assert.equal(seen[1].lastGroundedResult, undefined, `${label}: the stale ruling is not reusable`);
  }
});

test('15b. control: an unchanged snapshot keeps the grounded result valid', async () => {
  const { svc, seen } = make({ script: (_p, call) => (call === 1 ? grounded() : plain()) });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  const r = await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'hayd', duration_hours: 72 }));
  assert.equal(r.caseState?.groundedResult, 'valid');
  assert.ok(seen[1].lastGroundedResult, 'the grounded result is still reusable');
});

// ------------------------------------------------------------------- PRIVACY --
test('16. private mode still structurally strips appContext (and never tracks/removes anything)', async () => {
  const { svc, sc, seen } = make();
  const s = await svc.create('p', 'u', 'private');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'tuhr' }));
  assert.deepEqual(Object.keys(sc(s.id).facts), []);
  assert.equal(seen[0].context.current_state, undefined);
  assert.equal(seen[1].context.current_state, undefined);
});

// -------------------------------------------------------------- CONTINUITY ----
test('17. conversation continuity is intact across update and removal', async () => {
  const { svc, store, sc } = make({ interactions: CHOICE });
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd', duration_hours: 72 }));
  await svc.handleMessage('p', 'u', s.id, msg('خلاصة', undefined, { answers: [{ key: 'madhab_choice', value: 'x' }] }));
  await svc.handleMessage('p', 'u', s.id, msg('q3', { current_state: 'tuhr' }));
  await svc.handleMessage('p', 'u', s.id, msg('q4', { is_pregnant: false }));
  assert.equal(store.rows.size, 1, 'one conversation throughout');
  assert.equal(sc(s.id).turnCount, 4);
  assert.deepEqual(sc(s.id).recentTurns.map((t) => t.text).filter((t, i) => i % 2 === 0), ['q1', 'خلاصة', 'q3', 'q4']);
  assert.equal(sc(s.id).facts.is_pregnant, false);
});

// ------------------------------------------------------------------- MEMORY ---
test('18. no personal Memory write is introduced', async () => {
  const { svc, memoryCalls } = make();
  const s = await svc.create('p', 'u', 'contextual');
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'hayd' }));
  await svc.handleMessage('p', 'u', s.id, msg('q2', { current_state: 'tuhr' }));
  await svc.handleMessage('p', 'u', s.id, msg('q3', {}));
  assert.deepEqual([...new Set(memoryCalls)], ['fetchBounded'], 'only the read port is ever touched');
  assert.equal(policyFor('contextual').personalMemoryWrite, false);
  assert.equal(policyFor('private').personalMemoryWrite, false);
});

// --------------------------------------------- SESSIONS PERSISTED BEFORE THE FIX -
test('19. a session persisted BEFORE this fix (evidence facts without the origin marker) is refreshed and retracted too', async () => {
  const { svc, store, sc } = make();
  const s = await svc.create('p', 'u', 'contextual');
  const row = store.rows.get(s.id)!;
  row.sessionContext.facts = { current_state: 'hayd', duration_hours: 72 };
  row.sessionContext.factMeta = {
    current_state: { provenance: 'evidence', certainty: 'UNCERTAIN', at: '2026-10-01T00:00:00.000Z' },
    duration_hours: { provenance: 'evidence', certainty: 'UNCERTAIN', at: '2026-10-01T00:00:00.000Z' },
  };
  await svc.handleMessage('p', 'u', s.id, msg('q', { current_state: 'tuhr' }));
  assert.equal(sc(s.id).facts.current_state, 'tuhr');
  assert.equal(sc(s.id).facts.duration_hours, undefined);
  assert.equal(sc(s.id).factMeta!.current_state.origin, 'app', 'the marker is added from now on');
});

test('20. a fact with NO metadata is treated as unknown/stronger: neither overwritten nor removed', async () => {
  const { svc, store, sc } = make();
  const s = await svc.create('p', 'u', 'contextual');
  store.rows.get(s.id)!.sessionContext.facts = { current_state: 'hayd' };
  await svc.handleMessage('p', 'u', s.id, msg('q1', { current_state: 'tuhr' }));
  assert.equal(sc(s.id).facts.current_state, 'hayd', 'not overwritten');
  await svc.handleMessage('p', 'u', s.id, msg('q2', { duration_hours: 5 }));
  assert.equal(sc(s.id).facts.current_state, 'hayd', 'not removed');
});
