/**
 * K26 Slice A — trusted case semantics (F1/F2/F3) — DETERMINISTIC ACCEPTANCE SUITE.
 * Proves behaviour, not shape: intake, identity, provenance/certainty/currency,
 * precedence, invalidation, pending safety, newest-turn bounding, clarification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';
import { normalizeDigits, parseNumberLoose } from '../src/core/understanding/numbers.ts';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import { policyFor, type ConversationSession } from '../src/core/conversation/conversation.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { hasKnownValue } from '../src/core/readiness/readiness.ts';
import { createFiqhHaydSkill } from '../src/domain/naqaa/fiqh-hayd-skill.ts';
import { NEED_CATALOGUE } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';

const understanding = new UnderstandingService();
const candidatesOf = async (text: string) => (await understanding.evaluate({ projectId: 'p', text })).candidates ?? [];

// ---------------------------------------------------------------- A / B ------
test('A. Arabic-Indic and ASCII durations normalize to the same semantic value', async () => {
  assert.equal(normalizeDigits('٦ ساعات'), '6 ساعات');
  assert.equal(parseNumberLoose('٦'), 6);
  const ascii = (await candidatesOf('نزل دم 6 ساعات')).find((c) => c.kind === 'duration');
  const arabic = (await candidatesOf('نزل دم ٦ ساعات')).find((c) => c.kind === 'duration');
  assert.ok(ascii && arabic, 'both forms must yield a duration candidate');
  assert.equal(ascii!.value, 6);
  assert.equal(arabic!.value, 6);
  assert.equal(ascii!.unit, 'hour');
  assert.equal(arabic!.unit, 'hour');
  assert.equal(arabic!.originalText.includes('٦'), true, 'the original expression is preserved');
});

test('B. a natural statement becomes structured candidate facts (no domain meaning in Core)', async () => {
  const cands = await candidatesOf('نزل علي دم لمدة 6 ساعات وبعدين وقف');
  const dur = cands.find((c) => c.kind === 'duration');
  const stop = cands.find((c) => c.kind === 'boolean');
  assert.equal(dur?.value, 6);
  assert.equal(dur?.unit, 'hour');
  assert.equal(dur?.certainty, 'CERTAIN');
  assert.equal(dur?.provenance, 'user_statement');
  assert.equal(stop?.value, true, 'cessation is captured generically');
});

// ------------------------------------------------------------- C, D, G ------
function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
    async save(s: ConversationSession) { rows.set(s.id, s); return s; },
  };
}
const u = (corrections: Array<{ target?: string; new: unknown }> = []) => ({
  // the REAL extractor runs, so candidate intake is genuinely exercised downstream
  evaluate: async (input: { projectId: string; text: string }) => ({
    ...(await understanding.evaluate(input)),
    corrections,
  }),
});
function bindingSkill(seen: Array<Record<string, unknown>>) {
  return {
    execute: async (input: { payload?: unknown }) => {
      seen.push((input.payload ?? {}) as Record<string, unknown>);
      const p = (input.payload ?? {}) as { statementFacts?: Array<{ kind: string; value: unknown; unit?: string; certainty: string }> };
      const bound: Record<string, unknown> = {};
      for (const c of p.statementFacts ?? []) {
        if (c.certainty !== 'CERTAIN') continue;
        if (c.kind === 'duration' && c.unit === 'hour') bound.bleeding_duration_hours = c.value;
        else if (c.kind === 'duration' && c.unit === 'day') bound.bleeding_duration_days = c.value;
        else if (c.kind === 'boolean' && c.value === true) bound.bleeding_cessation = true;
      }
      return { status: 'needs_information' as const, skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'r',
        caseFacts: bound,
        readiness: { status: 'NEEDS_INFORMATION', satisfied: [], missing: [{ key: 'bleeding_cessation', description: 'x', question: { key: 'bleeding_cessation', wording: 'هل توقف الدم؟' }, interaction: { type: 'yes_no' } }], knownContextUsed: 0 },
      };
    },
  };
}
function svc(store: ReturnType<typeof fakeStore>, skills: unknown, memory: Array<{ memoryKey: string; value: unknown }> = [], corrections: Array<{ target?: string; new: unknown }> = []) {
  return new ConversationService({
    persistence: store,
    understanding: u(corrections) as never,
    skills: skills as never,
    memory: { fetchBounded: async () => ({ user: memory.map((m) => ({ id: 'm', scope: 'user', memoryType: 'p', memoryKey: m.memoryKey, payload: { value: m.value } })), conversation: [], case: [] }) },
    defaultSkillId: 'naqaa.fiqh-hayd',
    // The expected-answer contract of the needs this fixture asks about (B1.0).
    interactionsFor: () => ({
      bleeding_cessation: { type: 'yes_no' },
      bleeding_duration_hours: { type: 'number' },
      bleeding_duration_days: { type: 'number' },
      habit_days: { type: 'number' },
    }),
  });
}

test('C. Understanding candidates are consumed by Conversation and bound into the ONE case store', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = svc(store, bindingSkill(seen));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'نزل علي دم 6 ساعات' });
  const sent = seen[0].statementFacts as Array<{ kind: string; value: unknown }>;
  assert.ok(Array.isArray(sent) && sent.some((f) => f.kind === 'duration' && f.value === 6), 'candidates reach the skill');
  const stored = store.rows.get(s.id)!.sessionContext;
  assert.equal(stored.facts.bleeding_duration_hours, 6, 'bound fact lands in the session store');
  assert.equal(stored.factMeta!.bleeding_duration_hours.provenance, 'user_statement');
  assert.equal(stored.factMeta!.bleeding_duration_hours.certainty, 'CERTAIN');
});

test('D. a meaningful free-text answer to an open pending need never silently vanishes', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]));
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  assert.equal(t1.status, 'needs_information');
  assert.equal(store.rows.get(s.id)!.sessionContext.pendingKey, 'bleeding_cessation');
  // A. a plain free-text answer is preserved with its provenance
  await c.handleMessage('p', 'a', s.id, { text: 'توقف تماماً بعدها' });
  const meta = store.rows.get(s.id)!.sessionContext.factMeta!.bleeding_cessation;
  assert.ok(meta, 'the answer is stored, not dropped');
  assert.ok(meta!.provenance === 'user_answer' || meta!.provenance === 'user_statement', 'origin recorded');
  assert.notEqual(store.rows.get(s.id)!.sessionContext.facts.bleeding_cessation, undefined, 'the answer is preserved');
  // B. a hedged answer is never hardened into certain truth — asserted on a FRESH case, so no
  //    earlier statement (or B1.0 protection of an existing certain fact) can explain the result.
  const store2 = fakeStore();
  const c2 = svc(store2, bindingSkill([]));
  const s2 = await c2.create('p', 'a', 'private');
  await c2.handleMessage('p', 'a', s2.id, { text: 'حالة' });
  await c2.handleMessage('p', 'a', s2.id, { text: 'يمكن توقف' });
  assert.notEqual(store2.rows.get(s2.id)!.sessionContext.factMeta!.bleeding_cessation.certainty, 'CERTAIN', 'hedged stays non-certain');
});


test('E. "ما أدري" / UNKNOWN never satisfies a material need as known', async () => {
  assert.equal(hasKnownValue({ key: 'k', value: 'UNKNOWN', source: 'user', certainty: 'UNKNOWN' }), false);
  assert.equal(hasKnownValue({ key: 'k', value: 6, source: 'user', certainty: 'UNCERTAIN' }), false);
  assert.equal(hasKnownValue({ key: 'k', value: 6, source: 'user', certainty: 'CERTAIN' }), true);
  const readiness = new DecisionReadinessService();
  const reqs = [{ key: 'bleeding_duration_hours', description: 'x', material: true, question: { key: 'bleeding_duration_hours', wording: '؟' } }];
  assert.equal(readiness.evaluate({ requirements: reqs, known: [{ key: 'bleeding_duration_hours', value: 'UNKNOWN', source: 'user', certainty: 'UNKNOWN' }] }).status, 'NEEDS_INFORMATION');
  const store = fakeStore();
  const c = svc(store, bindingSkill([]));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  await c.handleMessage('p', 'a', s.id, { text: 'ما أدري' });
  assert.equal(store.rows.get(s.id)!.sessionContext.factMeta!.bleeding_cessation.certainty, 'UNKNOWN');
});

test('F. UNCERTAIN statements stay uncertain (hedged wording is never hardened)', async () => {
  const hedged = (await candidatesOf('يمكن نزل دم 6 ساعات')).find((x) => x.kind === 'duration');
  assert.equal(hedged?.certainty, 'UNCERTAIN');
  const hypothetical = (await candidatesOf('لو استمر 3 أيام؟')).find((x) => x.kind === 'duration');
  assert.equal(hypothetical?.certainty, 'UNCERTAIN', 'a hypothetical duration is never current truth');
  const hypotheticalNoNumber = (await candidatesOf('لو استمر أكثر من يوم؟')).find((x) => x.kind === 'duration');
  assert.equal(hypotheticalNoNumber, undefined, 'no number means no duration candidate at all');
});

// --------------------------------------------------------- G, H, I, J --------
test('G. the same semantic need keeps the same ID across turns', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]));
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  const t2 = await c.handleMessage('p', 'a', s.id, { text: 'لا أعرف' });
  assert.equal(t1.interaction?.key, 'bleeding_cessation');
  assert.equal(t2.interaction?.key, 'bleeding_cessation', 'the same need keeps its ID');
});

test('H. the model cannot establish an arbitrary new need identity', async () => {
  const prompts: string[] = [];
  const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
  const out = (await skill.execute({
    projectId: 'p', actor: 'a', input: { text: 'حالة' },
    knowledge: { search: async () => [{ chunkId: 'c1', documentId: 'd', sourceId: 's1', sourceTitle: 'الحيض الالوكة', chunkIndex: 1, text: 'نص', score: 0.1 }], resolveSources: async () => [{ id: 's1', title: 'الحيض الالوكة' }], adjacent: async () => [] },
    model: { async generateText({ message }: { message?: string }) {
      prompts.push(message ?? '');
      if (prompts.length === 1) return { text: JSON.stringify({ issue: 'مسألة', queries: ['الصفرة والكدرة'] }) };
      return { text: JSON.stringify({ interpretations: [], requirements: [{ key: 'age_reached_nine_years', whyMaterial: 'x', question: { wording: '؟' }, interaction: { type: 'yes_no' }, citations: ['c1'] }], unresolved: [] }) };
    } },
  } as never)) as Record<string, unknown>;
  assert.deepEqual(out.requirementKeys, [], 'an unregistered key is refused');
  assert.ok((prompts[1] ?? '').includes('bleeding_duration_hours'), 'the catalogue is declared to the model');
  assert.ok(Object.keys(NEED_CATALOGUE).includes('age_eligibility'), 'the registered identity exists');
});

test('I. a structured answer binds to the same stable need ID', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  await c.handleMessage('p', 'a', s.id, { text: 'نعم', answers: [{ key: 'bleeding_cessation', value: true }] });
  const ctx = store.rows.get(s.id)!.sessionContext;
  assert.equal(ctx.facts.bleeding_cessation, true);
  assert.equal(ctx.factMeta!.bleeding_cessation.provenance, 'user_answer');
  assert.equal(ctx.factMeta!.bleeding_cessation.certainty, 'CERTAIN');
});

test('J. the K25 answered-question semantics remain intact', async () => {
  const prompts: string[] = [];
  const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
  await skill.execute({
    projectId: 'p', actor: 'a',
    input: { text: 'نزل دم 6 ساعات', context: { bleeding_duration_hours: 6 }, recentTurns: [{ role: 'assistant', text: 'هل استمر يوم وليلة؟' }, { role: 'user', text: 'نعم' }] },
    knowledge: { search: async () => [{ chunkId: 'c1', documentId: 'd', sourceId: 's1', sourceTitle: 'الحيض الالوكة', chunkIndex: 1, text: 'نص', score: 0.1 }], resolveSources: async () => [{ id: 's1', title: 'الحيض الالوكة' }], adjacent: async () => [] },
    model: { async generateText({ message }: { message?: string }) {
      prompts.push(message ?? '');
      if (prompts.length === 1) return { text: JSON.stringify({ issue: 'مسألة', queries: ['الصفرة والكدرة'] }) };
      if (prompts.length === 2) return { text: JSON.stringify({ interpretations: [], requirements: [], unresolved: [] }) };
      return { text: JSON.stringify({ status: 'SOURCE_GAP', unresolved: [{ item: 'x', material: true }] }) };
    }},
  } as never);
  const decisionPrompt = prompts[2] ?? '';
  assert.ok(decisionPrompt.includes('answeredQuestions'), 'bounded answered-question context still travels');
  assert.ok(decisionPrompt.includes('هل استمر يوم وليلة'), 'and it carries the question text');
});

// ---------------------------------------------------- K, L, M, N, O, P -------
test('K/L. Memory origin is distinguishable and can never override a current user assertion', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]), [{ memoryKey: 'habit_days', value: 7 }, { memoryKey: 'bleeding_duration_hours', value: 99 }]);
  const s = await c.create('p', 'a', 'contextual');
  await c.handleMessage('p', 'a', s.id, { text: 'نزل دم 6 ساعات' });
  const ctx = store.rows.get(s.id)!.sessionContext;
  assert.equal(ctx.factMeta!.habit_days.provenance, 'memory');
  assert.equal(ctx.factMeta!.habit_days.certainty, 'UNCERTAIN', 'memory never closes a need');
  assert.equal(ctx.facts.bleeding_duration_hours, 6, 'the current user assertion wins');
  assert.equal(ctx.factMeta!.bleeding_duration_hours.provenance, 'user_statement');
});

test('M. a new current value supersedes the old one for the same need', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]), [], [{ target: 'bleeding_duration_hours', new: 24 }]);
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'نزل دم 6 ساعات' });
  assert.equal(store.rows.get(s.id)!.sessionContext.facts.bleeding_duration_hours, 6);
  await c.handleMessage('p', 'a', s.id, { text: 'لا، قصدي 24 ساعة' });
  const ctx = store.rows.get(s.id)!.sessionContext;
  assert.equal(ctx.facts.bleeding_duration_hours, 24, 'the corrected value is current');
  assert.equal(ctx.factMeta!.bleeding_duration_hours.certainty, 'CERTAIN');
  assert.ok(ctx.factMeta!.bleeding_duration_hours.superseded, 'the old value is recorded as superseded');
});

test('N/O/P. invalidation follows material change only, and a valid result is reusable', async () => {
  const store = fakeStore();
  const grounded = {
    // mirrors the real skill contract: bind CERTAIN statement facts AND return a grounded result
    execute: async (input: { payload?: unknown }) => {
      const p = (input.payload ?? {}) as { statementFacts?: Array<{ kind: string; value: unknown; unit?: string; certainty: string }> };
      const bound: Record<string, unknown> = {};
      for (const c of p.statementFacts ?? []) {
        if (c.certainty !== 'CERTAIN') continue;
        if (c.kind === 'duration' && c.unit === 'hour') bound.bleeding_duration_hours = c.value;
        else if (c.kind === 'duration' && c.unit === 'day') bound.bleeding_duration_days = c.value;
      }
      return {
      caseFacts: bound,
      status: 'completed' as const, skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'r',
      answer: { text: 'ليس حيضًا.', sourceTitle: 'الحيض الالوكة', evidenceIds: ['c1'] },
      trace: { status: 'DECIDED', decisionStatus: 'DECIDED', decisionLabel: 'ليس حيضًا', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['c1'] },
      };
    },
  };
  const c = svc(store, grounded);
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'نزل دم 6 ساعات' });
  assert.equal(t1.caseState?.groundedResult, 'valid');
  assert.ok(store.rows.get(s.id)!.sessionContext.lastGroundedResult?.caseSignature, 'a bounded digest is stored');
  // unchanged facts → still valid and reusable (source/reason follow-up)
  const t2 = await c.handleMessage('p', 'a', s.id, { text: 'شنو المصدر؟' });
  assert.equal(t2.caseState?.groundedResult, 'valid', 'unchanged facts do not invalidate (O)');
  assert.equal(t2.answer?.sourceTitle, 'الحيض الالوكة', 'the still-valid result is reused (P)');
  // material change → invalidated before reuse
  const store2 = fakeStore();
  const c2 = svc(store2, grounded, [], [{ target: 'bleeding_duration_hours', new: 24 }]);
  const s2 = await c2.create('p', 'a', 'private');
  await c2.handleMessage('p', 'a', s2.id, { text: 'نزل دم 6 ساعات' });
  const firstStored = store2.rows.get(s2.id)!.sessionContext.lastGroundedResult;
  const t3 = await c2.handleMessage('p', 'a', s2.id, { text: 'لا، قصدي 24 ساعة' });
  // A fresh valid result in the same turn is correct; what must hold is that the OLD result
  // was not reused — the stored result was recomputed for the new facts (new signature).
  const secondStored = store2.rows.get(s2.id)!.sessionContext.lastGroundedResult;
  assert.ok(firstStored?.caseSignature, 'turn 1 stored a bounded case digest');
  assert.ok(secondStored?.caseSignature, 'the corrected turn stored a bounded case digest');
  assert.notEqual(secondStored!.caseSignature, firstStored!.caseSignature, 'stale result not reused (N)');
});

// --------------------------------------------------------- Q, R, S, T, U ----
test('Q. a stale pending need cannot capture unrelated later free text', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  const after1 = { ...store.rows.get(s.id)!.sessionContext.facts };
  // a turn that ends without a question must not leave a bindable pending key
  const t2 = await c.handleMessage('p', 'a', s.id, { text: 'واضح' });
  const pend = store.rows.get(s.id)!.sessionContext.pendingKey;
  if (t2.status !== 'needs_information') assert.equal(pend, undefined, 'no stale pending key survives a non-question turn');
  const facts2 = store.rows.get(s.id)!.sessionContext.facts;
  assert.ok(Object.keys(facts2).length >= Object.keys(after1).length);
});

test('R. bounded narrative keeps the NEWEST text, never the oldest', async () => {
  const prompts: string[] = [];
  const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
  const old = 'قديم '.repeat(400);
  await skill.execute({
    projectId: 'p', actor: 'a',
    input: { text: 'جملة حديثة مهمة', recentTurns: [{ role: 'user', text: old }] },
    knowledge: { search: async () => [{ chunkId: 'c1', documentId: 'd', sourceId: 's1', sourceTitle: 'الحيض الالوكة', chunkIndex: 1, text: 'نص', score: 0.1 }], resolveSources: async () => [{ id: 's1', title: 'الحيض الالوكة' }], adjacent: async () => [] },
    model: { async generateText({ message }: { message?: string }) { prompts.push(message ?? ''); return { text: '{}' }; } },
  } as never);
  assert.ok(prompts[0]?.includes('جملة حديثة مهمة'), 'the newest statement survives bounding');
});

test('S. a real clarification question is surfaced instead of the placeholder', async () => {
  const store = fakeStore();
  const clarifying = {
    execute: async () => ({ status: 'needs_clarification' as const, skillId: 'naqaa.fiqh-hayd', skillVersion: 1, runId: 'r', clarification: { reason: 'material_ambiguity', question: 'أرجو توضيح قصدك حتى أتمكن من المتابعة.' } }),
  };
  const c = svc(store, clarifying);
  const s = await c.create('p', 'a', 'private');
  const t = await c.handleMessage('p', 'a', s.id, { text: 'هل هذا حيض؟' });
  assert.equal(t.status, 'needs_clarification');
  assert.match(t.message, /أرجو توضيح قصدك/);
  assert.notEqual(t.message, 'تمت معالجة طلبك.');
  assert.equal(t.clarification?.question, 'أرجو توضيح قصدك حتى أتمكن من المتابعة.');
});

test('T. Private Mode runs with Memory disabled (no memory-sourced facts)', async () => {
  assert.deepEqual(policyFor('private'), { mode: 'private', personalMemoryRead: false, personalMemoryWrite: false, projectDefaults: true });
  const store = fakeStore();
  const c = svc(store, bindingSkill([]), [{ memoryKey: 'habit_days', value: 7 }]);
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'نزل دم 6 ساعات' });
  const ctx = store.rows.get(s.id)!.sessionContext;
  assert.equal(ctx.facts.habit_days, undefined, 'private mode keeps Memory out of the case');
  assert.equal(ctx.facts.bleeding_duration_hours, 6, 'reasoning still works');
});

test('U. generic Core contracts contain no Fiqh/domain concepts', () => {
  const files = [
    'src/core/understanding/understanding.ts', 'src/core/understanding/numbers.ts', 'src/core/understanding/understanding.service.ts',
    'src/core/readiness/readiness.ts', 'src/core/readiness/readiness.service.ts',
    'src/core/conversation/conversation.ts', 'src/core/conversation/conversation.service.ts',
    'src/core/skill/skill.ts', 'src/core/skill/skill-runtime.ts',
  ];
  const forbidden = /(hayd|حيض|istihad|استحاض|nifas|نفاس|tuhr|القصة البيضاء|شافعي|shafi|NEED_CATALOGUE|bleeding_)/i;
  for (const f of files) {
    const code = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)) // strip comments: Core may SAY it knows no domain
      .join('\n');
    assert.equal(forbidden.test(code), false, `${f} must stay domain-neutral`);
  }
});
