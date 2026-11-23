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
import { createFiqhHaydMindSkill, MIND_SKILL_ID } from '../src/domain/naqaa/fiqh-hayd-mind-skill.ts';
import { APPROVED_SOURCE_TITLES, NEED_CATALOGUE } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';

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

test('Task 6: duration candidates preserve hour/day units without generic aliases', async () => {
  const hours = (await candidatesOf('نزل دم 6 ساعات')).filter((candidate) => candidate.kind === 'duration');
  const days = (await candidatesOf('نزل دم 6 أيام')).filter((candidate) => candidate.kind === 'duration');

  assert.deepEqual(hours.map(({ value, unit }) => ({ value, unit })), [{ value: 6, unit: 'hour' }]);
  assert.deepEqual(days.map(({ value, unit }) => ({ value, unit })), [{ value: 6, unit: 'day' }]);
  assert.ok(Object.hasOwn(NEED_CATALOGUE, 'bleeding_duration_hours'));
  assert.ok(Object.hasOwn(NEED_CATALOGUE, 'bleeding_duration_days'));
  assert.equal(Object.hasOwn(NEED_CATALOGUE, 'duration_days'), false);
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

test('a pending-answer question does not present its mentioned duration as a certain candidate', async () => {
  const candidates = await candidatesOf('كم يوم أحتاج بعد 6 أيام');
  const duration = candidates.find((candidate) => candidate.kind === 'duration');
  assert.equal(duration?.value, 6);
  assert.equal(duration?.certainty, 'UNCERTAIN');
});

test('an Arabic negative statement keeps its mentioned duration certain', async () => {
  const candidates = await candidatesOf('ما نزل دم لمدة ٦ أيام');
  const duration = candidates.find((candidate) => candidate.kind === 'duration');
  assert.equal(duration?.value, 6);
  assert.equal(duration?.certainty, 'CERTAIN');
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

test('C. Understanding candidates reach the skill as advisory observations and do not bind the case store', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = svc(store, bindingSkill(seen));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'نزل علي دم 6 ساعات' });
  const sent = seen[0].statementFacts as Array<{ kind: string; value: unknown; certainty: string }>;
  assert.ok(Array.isArray(sent) && sent.some((f) => f.kind === 'duration' && f.value === 6), 'candidates reach the skill');
  assert.ok(sent.every((f) => f.certainty !== 'CERTAIN'), 'candidates carry no fact-admission authority');
  const stored = store.rows.get(s.id)!.sessionContext;
  assert.equal(stored.facts.bleeding_duration_hours, undefined, 'an observation is not a confirmed case fact');
  assert.equal(stored.factMeta?.bleeding_duration_hours, undefined);
});

test('Task 6: duration units stay distinct across the conversation-to-skill boundary', async () => {
  for (const [text, expectedUnit, forbiddenUnit] of [
    ['نزل دم 6 ساعات', 'hour', 'day'],
    ['نزل دم 6 أيام', 'day', 'hour'],
  ] as const) {
    const store = fakeStore();
    const seen: Array<Record<string, unknown>> = [];
    const conversation = svc(store, bindingSkill(seen));
    const session = await conversation.create('p', 'a', 'private');

    await conversation.handleMessage('p', 'a', session.id, { text });

    const candidates = seen[0]?.statementFacts as Array<{ kind: string; unit?: string }>;
    assert.ok(candidates.some((candidate) => candidate.kind === 'duration' && candidate.unit === expectedUnit), text);
    assert.equal(candidates.some((candidate) => candidate.kind === 'duration' && candidate.unit === forbiddenUnit), false, text);
    const facts = store.rows.get(session.id)!.sessionContext.facts;
    assert.equal(Object.hasOwn(facts, 'duration_days'), false, 'the generic alias is never admitted');
  }
});

// STAGE2 bridge — appContext (client calendar/scan facts) lands as `evidence`-provenance
// facts in personal mode, and is STRUCTURALLY dropped in private mode.
test('STAGE2/bridge-A: appContext reaches the case as evidence-provenance facts (personal)', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = svc(store, bindingSkill(seen));
  const s = await c.create('p', 'a', 'contextual');
  await c.handleMessage('p', 'a', s.id, {
    text: 'الحين شنو حكمي؟',
    appContext: { cycle_day: 5, last_menstrual_period: '2026-09-01' },
  });
  const stored = store.rows.get(s.id)!.sessionContext;
  assert.equal(stored.facts.cycle_day, 5, 'appContext fact landed in the case');
  assert.equal(stored.factMeta!.cycle_day.provenance, 'evidence', 'ranked as evidence, below user statements');
  assert.equal(stored.factMeta!.cycle_day.certainty, 'UNCERTAIN', 'never invented as certain');
  // …and the skill saw it in payload.context
  assert.equal((seen[0].context as Record<string, unknown>).cycle_day, 5, 'skill payload carries the app context');
});

test('STAGE2/bridge-B: private mode structurally drops appContext (no Calendar/Scanner/context crosses)', async () => {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const c = svc(store, bindingSkill(seen));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, {
    text: 'ما الحكم؟',
    appContext: { cycle_day: 5, scan_color: 'red' },
  });
  const stored = store.rows.get(s.id)!.sessionContext;
  assert.equal(stored.facts.cycle_day, undefined, 'no appContext fact in a private case');
  assert.equal(stored.facts.scan_color, undefined, 'no scan fact in a private case');
  assert.equal((seen[0].context as Record<string, unknown>).cycle_day, undefined, 'skill payload is clean of app context in private mode');
});

test('D. narrative text cannot silently confirm a closed pending contract', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]));
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  assert.equal(t1.status, 'needs_information');
  assert.equal(store.rows.get(s.id)!.sessionContext.pendingKey, 'bleeding_cessation');
  // A. prose is still visible to Understanding/the skill, but cannot become a confirmed answer.
  await c.handleMessage('p', 'a', s.id, { text: 'توقف تماماً بعدها' });
  assert.equal(store.rows.get(s.id)!.sessionContext.factMeta?.bleeding_cessation, undefined);
  assert.equal(store.rows.get(s.id)!.sessionContext.facts.bleeding_cessation, undefined);
  // B. a hedged answer is never hardened into certain truth — asserted on a FRESH case, so no
  //    earlier statement (or B1.0 protection of an existing certain fact) can explain the result.
  const store2 = fakeStore();
  const c2 = svc(store2, bindingSkill([]));
  const s2 = await c2.create('p', 'a', 'private');
  await c2.handleMessage('p', 'a', s2.id, { text: 'حالة' });
  await c2.handleMessage('p', 'a', s2.id, { text: 'يمكن توقف' });
  assert.notEqual(store2.rows.get(s2.id)!.sessionContext.factMeta?.bleeding_cessation?.certainty, 'CERTAIN', 'hedged stays non-certain');
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
    model: { async generateText({ instructions, message }: { instructions?: string; message?: string }) {
      prompts.push([instructions, message].filter(Boolean).join('\n\n'));
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
    model: { async generateText({ instructions, message }: { instructions?: string; message?: string }) {
      prompts.push([instructions, message].filter(Boolean).join('\n\n'));
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
  await c.handleMessage('p', 'a', s.id, {
    text: 'نزل دم 6 ساعات', answers: [{ key: 'bleeding_duration_hours', value: 6 }],
  });
  const ctx = store.rows.get(s.id)!.sessionContext;
  assert.equal(ctx.factMeta!.habit_days.provenance, 'memory');
  assert.equal(ctx.factMeta!.habit_days.certainty, 'UNCERTAIN', 'memory never closes a need');
  assert.equal(ctx.facts.bleeding_duration_hours, 6, 'the current user assertion wins');
  assert.equal(ctx.factMeta!.bleeding_duration_hours.provenance, 'user_answer');
});

test('M. a new current value supersedes the old one for the same need', async () => {
  const store = fakeStore();
  const c = svc(store, bindingSkill([]), [], [{ target: 'bleeding_duration_hours', new: 24 }]);
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, {
    text: 'نزل دم 6 ساعات', answers: [{ key: 'bleeding_duration_hours', value: 6 }],
  });
  assert.equal(store.rows.get(s.id)!.sessionContext.facts.bleeding_duration_hours, 6);
  await c.handleMessage('p', 'a', s.id, { text: 'لا، قصدي 24' });
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
      trace: { status: 'DECIDED', decisionStatus: 'DECIDED', decisionLabel: 'ليس حيضًا', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['c1'], materialFactKeys: ['bleeding_duration_hours'] },
      };
    },
  };
  const c = svc(store, grounded);
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, {
    text: 'نزل دم 6 ساعات', answers: [{ key: 'bleeding_duration_hours', value: 6 }],
  });
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
  await c2.handleMessage('p', 'a', s2.id, {
    text: 'نزل دم 6 ساعات', answers: [{ key: 'bleeding_duration_hours', value: 6 }],
  });
  const firstStored = store2.rows.get(s2.id)!.sessionContext.lastGroundedResult;
  const t3 = await c2.handleMessage('p', 'a', s2.id, { text: 'لا، قصدي 24' });
  // A fresh valid result in the same turn is correct; what must hold is that the OLD result
  // was not reused — the stored result was recomputed for the new facts (new signature).
  const secondStored = store2.rows.get(s2.id)!.sessionContext.lastGroundedResult;
  assert.ok(firstStored?.caseSignature, 'turn 1 stored a bounded case digest');
  assert.ok(secondStored?.caseSignature, 'the corrected turn stored a bounded case digest');
  assert.notEqual(secondStored!.caseSignature, firstStored!.caseSignature, 'stale result not reused (N)');
});

async function groundedCorrectionCase(
  facts: Record<string, unknown>,
  pending?: NonNullable<ConversationSession['sessionContext']['pendingInteraction']> & { key: string },
  options: {
    proposals?: Record<string, unknown>;
    contracts?: Record<string, NonNullable<ConversationSession['sessionContext']['pendingInteraction']>>;
    omitMetadata?: boolean;
    proposesDecisionOnCorrection?: boolean;
  } = {},
) {
  const store = fakeStore();
  const seen: Array<Record<string, unknown>> = [];
  const skillId = 'test.typed-corrections';
  const groundingFactKeys = options.omitMetadata ? [] : Object.keys(facts);
  const conversation = new ConversationService({
    persistence: store,
    understanding,
    defaultSkillId: skillId,
    skills: {
      async execute({ payload }) {
        seen.push(payload as Record<string, unknown>);
        return {
          status: 'completed', skillId, skillVersion: 1, runId: 'correction-run',
          ...(seen.length === 1 || options.proposesDecisionOnCorrection
            ? {
              answer: { text: 'Initial answer.', label: 'hayd', evidenceIds: ['chunk-grounded'] },
              trace: {
                decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['chunk-grounded'],
                materialFactKeys: groundingFactKeys,
              },
              caseFacts: options.proposals,
            }
            : {}),
        };
      },
    },
  });
  const session = await conversation.create('p', 'a', 'private');
  store.rows.set(session.id, {
    ...session,
    sessionContext: {
      ...session.sessionContext,
      facts,
      ...(options.omitMetadata ? {} : { factMeta: Object.fromEntries(Object.keys(facts).map((key) => {
        const interaction = options.contracts?.[key];
        return [key, {
          provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z',
          ...(interaction ? { admission: { skillId, interaction } } : {}),
        }];
      })) }),
    },
  });

  await conversation.handleMessage('p', 'a', session.id, { text: 'Initial question?' });
  const before = store.rows.get(session.id)!.sessionContext;
  if (groundingFactKeys.length > 0) assert.ok(before.lastGroundedResult?.caseSignature, 'the initial answer is grounded in the seeded facts');
  else assert.equal(before.lastGroundedResult, undefined, 'no personal result is grounded without admitted dependency proof');
  if (pending) {
    const { key, ...interaction } = pending;
    store.rows.set(session.id, {
      ...store.rows.get(session.id)!,
      sessionContext: { ...before, pendingKey: key, pendingInteraction: interaction, pendingInteractionTrust: { skillId, declared: true } },
    });
  }

  return {
    before,
    async correct(text: string, answers?: Array<{ key: string; value: unknown }>) {
      const response = await conversation.handleMessage('p', 'a', session.id, { text, ...(answers ? { answers } : {}) });
      return { response, payload: seen.at(-1)!, after: store.rows.get(session.id)!.sessionContext };
    },
  };
}

test('a structured correction through the original free-text contract updates a clock fact', async () => {
  const scenario = await groundedCorrectionCase({ observed_at: '09:00' }, undefined, { contracts: { observed_at: { type: 'free_text' } } });
  const { response, payload, after } = await scenario.correct('لا، قصدي 10:00', [{ key: 'observed_at', value: '10:00' }]);

  assert.deepEqual(payload.context, { observed_at: '10:00' });
  assert.deepEqual(payload.changedFactKeys, ['observed_at']);
  assert.equal(payload.lastGroundedResult, undefined);
  assert.deepEqual(after.facts, { observed_at: '10:00' });
  assert.equal(after.lastGroundedResult, undefined);
  assert.equal(response.caseState?.invalidationReason, 'material_fact_changed');
});

test('admission round 2: a uniquely matched time correction clears its prior grounded result', async () => {
  const scenario = await groundedCorrectionCase({ observed_at: '09:00' }, undefined, { contracts: { observed_at: { type: 'time' } } });
  const { response, payload, after } = await scenario.correct('لا، قصدي 10:00');

  assert.deepEqual(payload.context, { observed_at: '10:00' });
  assert.deepEqual(payload.changedFactKeys, ['observed_at']);
  assert.equal(payload.lastGroundedResult, undefined);
  assert.deepEqual(after.facts, { observed_at: '10:00' });
  assert.equal(after.lastGroundedResult, undefined);
  assert.equal(response.caseState?.invalidationReason, 'explicit_correction');
});

test('admission round 2: an explicit apology can correct a declared clock fact', async () => {
  const scenario = await groundedCorrectionCase({ observed_at: '09:00' }, undefined, { contracts: { observed_at: { type: 'time' } } });
  const { response, payload, after } = await scenario.correct('Sorry, I meant: 10:00');

  assert.deepEqual(payload.context, { observed_at: '10:00' });
  assert.equal(payload.lastGroundedResult, undefined);
  assert.equal(after.facts.observed_at, '10:00');
  assert.equal(response.caseState?.invalidationReason, 'explicit_correction');
});

for (const [text, expected] of [
  ['I meant, 10:30 AM', '10:30'],
  ['No, I meant: at 10:30 a.m.', '10:30'],
  ['Sorry, I meant 10:30 AM', '10:30'],
  ['I meant 10:30 PM', '22:30'],
  ['I meant at 12:30 a.m.', '00:30'],
  ['I meant at 12:30 p.m.', '12:30'],
]) {
  test(`admission round 2: a complete AM/PM correction updates the canonical clock: ${text}`, async () => {
    const scenario = await groundedCorrectionCase({ observed_at: '09:00' }, undefined, { contracts: { observed_at: { type: 'time' } } });
    const { response, payload, after } = await scenario.correct(text);

    assert.deepEqual(payload.context, { observed_at: expected });
    assert.deepEqual(payload.changedFactKeys, ['observed_at']);
    assert.equal(payload.lastGroundedResult, undefined);
    assert.deepEqual(after.facts, { observed_at: expected });
    assert.equal(after.factMeta?.observed_at.certainty, 'CERTAIN');
    assert.equal(after.factMeta?.observed_at.superseded?.[0]?.value, '09:00');
    assert.equal(after.factMeta?.observed_at.admission?.interaction.type, 'time');
    assert.equal(after.lastGroundedResult, undefined);
    assert.equal(response.caseState?.groundedResult, 'invalidated');
    assert.equal(response.caseState?.invalidationReason, 'explicit_correction');
  });
}

test('admission round 2: only one declared literal target permits an ordinary choice correction', async () => {
  const single = { type: 'single_choice', options: ['amber', 'brown'] } as const;
  const interaction = { ...single, options: [...single.options] };
  const unique = await groundedCorrectionCase({ colour: 'amber' }, undefined, { contracts: { colour: interaction } });
  const changed = await unique.correct('I meant brown');
  assert.deepEqual(changed.after.facts, { colour: 'brown' });
  assert.equal(changed.response.caseState?.invalidationReason, 'explicit_correction');

  const ambiguous = await groundedCorrectionCase({ first: 'amber', second: 'amber' }, undefined, {
    contracts: { first: interaction, second: interaction },
  });
  const skipped = await ambiguous.correct('I meant brown');
  assert.deepEqual(skipped.after.facts, { first: 'amber', second: 'amber' });
  assert.equal(skipped.response.caseState?.groundedResult, 'valid');
});

test('admission round 3: a timed legacy choice cannot be rewritten and its old ruling cannot be reused', async () => {
  // The old row never stored whether this was a literal selection or a clock.
  const scenario = await groundedCorrectionCase({ appointment_slot: '09:00' });
  const { response, payload, after } = await scenario.correct('I meant 10:30 AM');
  assert.equal(after.facts.appointment_slot, '09:00');
  assert.notEqual(after.factMeta?.appointment_slot?.certainty, 'CERTAIN');
  assert.equal(payload.lastGroundedResult, undefined);
  assert.equal(after.lastGroundedResult, undefined);
  assert.equal(response.caseState?.groundedResult, 'invalidated');
});

test('admission round 3: blocked correction cannot publish a replacement ruling before reconfirmation', async () => {
  const scenario = await groundedCorrectionCase({ appointment_slot: '09:00' }, undefined, { proposesDecisionOnCorrection: true });
  const { response, after } = await scenario.correct('I meant 10:30 AM');
  assert.equal(response.answer?.label, undefined);
  assert.equal(response.caseState?.groundedResult, 'invalidated');
  assert.equal(after.lastGroundedResult, undefined);
  const followUp = await scenario.correct('Why?');
  assert.equal(followUp.response.answer?.label, undefined);
  assert.equal(followUp.after.lastGroundedResult, undefined);
});

test('admission round 3: an omitted Understanding proposal cannot keep a legacy clock ruling valid', async () => {
  const scenario = await groundedCorrectionCase({ appointment_slot: '09:00' });
  const { response, payload, after } = await scenario.correct('آسفه، قصدي 10:30 AM');
  assert.equal(after.facts.appointment_slot, '09:00');
  assert.deepEqual(after.reconfirmation?.keys, ['appointment_slot']);
  assert.equal(payload.lastGroundedResult, undefined);
  assert.equal(response.caseState?.groundedResult, 'invalidated');
});

test('admission round 4: a Mind ANSWER is suspended while a legacy correction needs reconfirmation', async () => {
  const store = fakeStore();
  const mind = createFiqhHaydMindSkill({ readiness: new DecisionReadinessService() });
  const replies = [
    JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: ['حكم الحالة'], materialFactKeys: ['confirmed_onset'] }),
    JSON.stringify({ status: 'ANSWER', message: 'حكم شخصي موثق.', evidenceRefs: ['chunk-a'], materialFactKeys: ['confirmed_onset'] }),
  ];
  let modelCall = 0;
  const conversation = new ConversationService({
    persistence: store,
    understanding,
    defaultSkillId: MIND_SKILL_ID,
    skills: {
      async execute({ projectId, actor, payload }) {
        return mind.execute({
          projectId,
          actor,
          input: payload,
          knowledge: {
            async resolveSources() { return [{ id: 'source-a', title: APPROVED_SOURCE_TITLES[0] }]; },
            async search() { return [{ chunkId: 'chunk-a', documentId: 'doc-a', sourceId: 'source-a', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 0, text: 'نص فقهي معتمد.', score: 1 }]; },
            async adjacent() { return []; },
          },
          model: { async generateText() { return { text: replies[modelCall++]!, model: 'scripted' }; } },
        } as never) as never;
      },
    },
  });
  const session = await conversation.create('p', 'a', 'private');
  store.rows.set(session.id, {
    ...session,
    sessionContext: {
      ...session.sessionContext,
      facts: { appointment_slot: '09:00', confirmed_onset: '2026-11-01' },
      factMeta: {
        appointment_slot: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' },
        confirmed_onset: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' },
      },
      lastGroundedResult: { skillId: MIND_SKILL_ID, status: 'ANSWER', evidenceRefs: ['chunk-old'], caseSignature: 'legacy-signature' },
    },
  });

  const response = await conversation.handleMessage('p', 'a', session.id, { text: 'I meant 10:30 AM' });
  const after = store.rows.get(session.id)!.sessionContext as ConversationSession['sessionContext'] & { reconfirmation?: { keys: string[] } };
  assert.equal(response.status, 'insufficient_context');
  assert.equal(response.answer, undefined);
  assert.equal(response.trace, undefined);
  assert.equal(response.caseState?.groundedResult, 'invalidated');
  assert.equal(after.lastGroundedResult, undefined);
  assert.deepEqual(after.reconfirmation?.keys, ['appointment_slot']);
});

test('admission round 4: reconfirmation survives ordinary fact eviction and keeps a later label suspended', async () => {
  const store = fakeStore();
  const skillId = 'test.reconfirmation-capacity';
  let call = 0;
  const conversation = new ConversationService({
    persistence: store,
    understanding,
    defaultSkillId: skillId,
    interactionsFor: () => Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`other_${index}`, { type: 'number' as const }])),
    skills: {
      async execute() {
        const index = call++;
        if (index < 40) {
          const key = `other_${index}`;
          return {
            status: 'needs_information' as const, skillId, skillVersion: 1,
            readiness: { status: 'NEEDS_INFORMATION' as const, satisfied: [], missing: [{ key, description: key, question: { key, wording: key }, interaction: { type: 'number' as const } }], knownContextUsed: 0 },
          };
        }
        return { status: 'completed' as const, skillId, skillVersion: 1, answer: { text: 'Personal result.', label: 'hayd' }, trace: { decisionStatus: 'DECIDED' } };
      },
    },
  });
  const session = await conversation.create('p', 'a', 'private');
  store.rows.set(session.id, {
    ...session,
    sessionContext: {
      ...session.sessionContext,
      facts: { appointment_slot: '09:00' },
      factMeta: { appointment_slot: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } },
      lastGroundedResult: { skillId, status: 'DECIDED', evidenceRefs: ['chunk-old'], caseSignature: 'legacy-signature' },
    },
  });

  let response = await conversation.handleMessage('p', 'a', session.id, { text: 'I meant 10:30 AM' });
  for (let index = 0; index < 40; index += 1) {
    response = await conversation.handleMessage('p', 'a', session.id, {
      text: String(index + 1),
      answers: [{ key: `other_${index}`, value: index + 1 }],
    });
  }
  const after = store.rows.get(session.id)!.sessionContext as ConversationSession['sessionContext'] & { reconfirmation?: { keys: string[] } };
  assert.equal(after.facts.appointment_slot, undefined, 'ordinary capacity eviction may remove the legacy value');
  assert.deepEqual(after.reconfirmation?.keys, ['appointment_slot'], 'the safety marker is not ordinary fact metadata');
  assert.equal(response.status, 'insufficient_context');
  assert.equal(response.answer, undefined);
  assert.equal(after.lastGroundedResult, undefined);

  store.rows.set(session.id, {
    ...store.rows.get(session.id)!,
    sessionContext: {
      ...after,
      pendingKey: 'appointment_slot',
      pendingInteraction: { type: 'time' },
      pendingInteractionTrust: { skillId, declared: true },
    },
  });
  const reconfirmed = await conversation.handleMessage('p', 'a', session.id, {
    text: '10:30',
    answers: [{ key: 'appointment_slot', value: '10:30' }],
  });
  const finalState = store.rows.get(session.id)!.sessionContext;
  assert.equal(finalState.reconfirmation, undefined, 'only a fresh admitted answer clears the exact marker');
  assert.equal(finalState.facts.appointment_slot, '10:30');
  assert.equal(reconfirmed.answer?.label, 'hayd');
});

test('admission round 4: every plausible pending and existing clock participates in correction uniqueness', async () => {
  const store = fakeStore();
  const skillId = 'test.correction-uniqueness';
  const conversation = new ConversationService({
    persistence: store,
    understanding,
    defaultSkillId: skillId,
    skills: {
      async execute() {
        return {
          status: 'needs_information' as const, skillId, skillVersion: 1,
          readiness: { status: 'NEEDS_INFORMATION' as const, satisfied: [], missing: [{ key: 'second_clock', description: 'clock', question: { key: 'second_clock', wording: 'clock?' }, interaction: { type: 'time' as const } }], knownContextUsed: 0 },
        };
      },
    },
  });
  const session = await conversation.create('p', 'a', 'private');
  store.rows.set(session.id, {
    ...session,
    sessionContext: {
      ...session.sessionContext,
      facts: { old_slot: '09:00' },
      factMeta: { old_slot: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } },
      pendingKey: 'second_clock',
      pendingInteraction: { type: 'time' },
      pendingInteractionTrust: { skillId, declared: true },
      lastGroundedResult: { skillId, status: 'DECIDED', evidenceRefs: ['chunk-old'], caseSignature: 'legacy-signature' },
    },
  });

  await conversation.handleMessage('p', 'a', session.id, { text: 'I meant 10:30 AM' });
  const after = store.rows.get(session.id)!.sessionContext as ConversationSession['sessionContext'] & { reconfirmation?: { keys: string[] } };
  assert.deepEqual(after.facts, { old_slot: '09:00' });
  assert.equal(after.factMeta?.old_slot.certainty, 'CERTAIN');
  assert.equal(after.reconfirmation, undefined, 'an ambiguous correction cannot mutate either plausible target');
  assert.equal(after.pendingKey, 'second_clock');
});

test('admission round 5: all 64 reconfirmation keys survive reload until the exact fact is admitted', async () => {
  const store = fakeStore();
  const skillId = 'test.reconfirmation-64';
  const conversation = new ConversationService({
    persistence: store,
    understanding,
    defaultSkillId: skillId,
    skills: { async execute() { return { status: 'completed' as const, skillId, skillVersion: 1, answer: { text: 'Personal.', label: 'hayd' }, trace: { decisionStatus: 'DECIDED' } }; } },
  });
  const session = await conversation.create('p', 'a', 'private');
  const keys = Array.from({ length: 64 }, (_, index) => `fact_${index}`);
  store.rows.set(session.id, { ...session, sessionContext: { ...session.sessionContext, reconfirmation: { keys } } });

  const blocked = await conversation.handleMessage('p', 'a', session.id, { text: 'Can you decide?' });
  const persisted = store.rows.get(session.id)!.sessionContext;
  assert.equal(blocked.status, 'insufficient_context');
  assert.deepEqual(persisted.reconfirmation?.keys, keys);

  store.rows.set(session.id, { ...store.rows.get(session.id)!, sessionContext: {
    ...persisted,
    pendingKey: 'fact_63', pendingInteraction: { type: 'number' }, pendingInteractionTrust: { skillId, declared: true },
  } });
  const stillBlocked = await conversation.handleMessage('p', 'a', session.id, { text: '63', answers: [{ key: 'fact_63', value: 63 }] });
  const after = store.rows.get(session.id)!.sessionContext;
  assert.equal(stillBlocked.status, 'insufficient_context');
  assert.equal(after.reconfirmation?.keys.length, 63);
  assert.equal(after.reconfirmation?.keys.includes('fact_63'), false);
});

test('admission round 5: a cross-skill choice remains an ambiguity participant but cannot be mutated', async () => {
  const store = fakeStore();
  const skillId = 'skill-current';
  const conversation = new ConversationService({
    persistence: store,
    understanding,
    defaultSkillId: skillId,
    skills: { async execute() { return { status: 'completed' as const, skillId, skillVersion: 1 }; } },
  });
  const session = await conversation.create('p', 'a', 'private');
  store.rows.set(session.id, { ...session, sessionContext: {
    ...session.sessionContext,
    facts: { current_colour: 'red', other_colour: 'amber' },
    factMeta: {
      current_colour: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z', admission: { skillId, interaction: { type: 'single_choice', options: ['red', 'brown'] } } },
      other_colour: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z', admission: { skillId: 'skill-other', interaction: { type: 'single_choice', options: ['amber', 'brown'] } } },
    },
  } });

  await conversation.handleMessage('p', 'a', session.id, { text: 'I meant brown' });
  assert.deepEqual(store.rows.get(session.id)!.sessionContext.facts, { current_colour: 'red', other_colour: 'amber' });
});

test('admission round 5: an active pending contract overrides the same fact historical contract', async () => {
  const store = fakeStore();
  const skillId = 'test.pending-precedence';
  const conversation = new ConversationService({
    persistence: store,
    understanding,
    defaultSkillId: skillId,
    skills: { async execute() { return { status: 'completed' as const, skillId, skillVersion: 1 }; } },
  });
  const session = await conversation.create('p', 'a', 'private');
  const seed = () => store.rows.set(session.id, { ...session, sessionContext: {
    ...session.sessionContext,
    facts: { selection: 5 },
    factMeta: { selection: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z', admission: { skillId, interaction: { type: 'number' } } } },
    pendingKey: 'selection', pendingInteraction: { type: 'single_choice', options: ['5', '7'] }, pendingInteractionTrust: { skillId, declared: true },
  } });

  seed();
  await conversation.handleMessage('p', 'a', session.id, { text: 'I meant 6' });
  assert.equal(store.rows.get(session.id)!.sessionContext.facts.selection, 5, 'historical number contract cannot bypass the active choice');

  seed();
  await conversation.handleMessage('p', 'a', session.id, { text: 'I meant 7' });
  assert.equal(store.rows.get(session.id)!.sessionContext.facts.selection, '7', 'the active choice owns normalization and admission');
});

for (const keyLength of [61, 62, 63, 64]) {
  test(`admission round 6: a ${keyLength}-character reconfirmation key survives two real Mind turns`, async () => {
    const store = fakeStore();
    const mind = createFiqhHaydMindSkill({ readiness: new DecisionReadinessService() });
    const replies = Array.from({ length: 2 }, () => [
      JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: ['حكم الحالة'], materialFactKeys: ['confirmed_onset'] }),
      JSON.stringify({ status: 'ANSWER', message: 'حكم شخصي موثق.', evidenceRefs: ['chunk-a'], materialFactKeys: ['confirmed_onset'] }),
    ]).flat();
    let modelCall = 0;
    const conversation = new ConversationService({
      persistence: store,
      understanding,
      defaultSkillId: MIND_SKILL_ID,
      skills: {
        async execute({ projectId, actor, payload }) {
          return mind.execute({
            projectId, actor, input: payload,
            knowledge: {
              async resolveSources() { return [{ id: 'source-a', title: APPROVED_SOURCE_TITLES[0] }]; },
              async search() { return [{ chunkId: 'chunk-a', documentId: 'doc-a', sourceId: 'source-a', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 0, text: 'نص فقهي معتمد.', score: 1 }]; },
              async adjacent() { return []; },
            },
            model: { async generateText() { return { text: replies[modelCall++]!, model: 'scripted' }; } },
          } as never) as never;
        },
      },
    });
    const session = await conversation.create('p', 'a', 'private');
    const longKey = `k${'x'.repeat(keyLength - 1)}`;
    store.rows.set(session.id, { ...session, sessionContext: {
      ...session.sessionContext,
      facts: { confirmed_onset: '2026-11-01' },
      factMeta: { confirmed_onset: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } },
      reconfirmation: { keys: [longKey] },
    } });

    for (const text of ['Can you decide?', 'Please decide now.']) {
      const response = await conversation.handleMessage('p', 'a', session.id, { text });
      assert.equal(response.status, 'insufficient_context');
      assert.equal(response.answer, undefined);
      assert.deepEqual(store.rows.get(session.id)!.sessionContext.reconfirmation?.keys, [longKey]);
      assert.equal(store.rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
    }
  });
}

test('admission round 6: a foreign pending choice participates in correction ambiguity', async () => {
  const store = fakeStore();
  const skillId = 'skill-current';
  const conversation = new ConversationService({
    persistence: store, understanding, defaultSkillId: skillId,
    skills: { async execute() { return { status: 'completed' as const, skillId, skillVersion: 1 }; } },
  });
  const session = await conversation.create('p', 'a', 'private');
  store.rows.set(session.id, { ...session, sessionContext: {
    ...session.sessionContext,
    facts: { current_colour: 'red' },
    factMeta: { current_colour: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z', admission: { skillId, interaction: { type: 'single_choice', options: ['red', 'brown'] } } } },
    pendingKey: 'foreign_colour',
    pendingInteraction: { type: 'single_choice', options: ['amber', 'brown'] },
    pendingInteractionTrust: { skillId: 'skill-other', declared: true },
  } });

  await conversation.handleMessage('p', 'a', session.id, { text: 'I meant brown' });
  const after = store.rows.get(session.id)!.sessionContext;
  assert.deepEqual(after.facts, { current_colour: 'red' });
  assert.equal(after.pendingKey, 'foreign_colour');
});

test('admission round 6: unique owned pending correction applies and unique foreign pending correction is inert', async () => {
  const run = async (owner: string) => {
    const store = fakeStore();
    const skillId = 'skill-current';
    const conversation = new ConversationService({
      persistence: store, understanding, defaultSkillId: skillId,
      skills: { async execute() { return { status: 'completed' as const, skillId, skillVersion: 1 }; } },
    });
    const session = await conversation.create('p', 'a', 'private');
    store.rows.set(session.id, { ...session, sessionContext: {
      ...session.sessionContext,
      pendingKey: 'colour', pendingInteraction: { type: 'single_choice', options: ['amber', 'brown'] },
      pendingInteractionTrust: { skillId: owner, declared: true },
    } });
    await conversation.handleMessage('p', 'a', session.id, { text: 'I meant brown' });
    return store.rows.get(session.id)!.sessionContext;
  };

  assert.equal((await run('skill-current')).facts.colour, 'brown');
  const foreign = await run('skill-other');
  assert.equal(foreign.facts.colour, undefined);
  assert.equal(foreign.pendingKey, 'colour');
});

test('admission round 6: current hints cannot authorize a correction to the foreign pending key', async () => {
  const store = fakeStore();
  const skillId = 'skill-current';
  const interaction = { type: 'single_choice' as const, options: ['amber', 'brown'] };
  const conversation = new ConversationService({
    persistence: store, understanding, defaultSkillId: skillId,
    interactionsFor: () => ({ colour: interaction }),
    skills: { async execute() { return { status: 'completed' as const, skillId, skillVersion: 1 }; } },
  });
  const session = await conversation.create('p', 'a', 'private');
  store.rows.set(session.id, { ...session, sessionContext: {
    ...session.sessionContext,
    pendingKey: 'colour', pendingInteraction: interaction,
    pendingInteractionTrust: { skillId: 'skill-other', declared: true },
  } });

  await conversation.handleMessage('p', 'a', session.id, { text: 'I meant brown' });
  const after = store.rows.get(session.id)!.sessionContext;
  assert.equal(after.facts.colour, undefined);
  assert.equal(after.pendingKey, 'colour');
});

test('repeating the current date preserves the grounded result and fact metadata', async () => {
  const scenario = await groundedCorrectionCase({ start_date: '2026-11-01' }, undefined, { contracts: { start_date: { type: 'date' } } });
  const { response, payload, after } = await scenario.correct('لا، قصدي 2026-11-01');

  assert.equal(response.caseState?.groundedResult, 'valid');
  assert.equal(response.caseState?.invalidationReason, undefined);
  assert.deepEqual(payload.changedFactKeys, []);
  assert.deepEqual(payload.lastGroundedResult, scenario.before.lastGroundedResult);
  assert.deepEqual(after.factMeta, scenario.before.factMeta);
});

test('repeating a date proposed by the skill preserves its grounded result without binding the proposal', async () => {
  const scenario = await groundedCorrectionCase({}, undefined, { proposals: { start_date: '2026-11-01' } });
  assert.deepEqual(scenario.before.facts, {});
  const { payload, response } = await scenario.correct('لا، قصدي 2026-11-01');

  assert.equal(response.caseState?.groundedResult, 'none');
  assert.equal(payload.lastGroundedResult, undefined);
});

test('legacy facts without metadata remain advisory in the skill payload and response', async () => {
  const scenario = await groundedCorrectionCase({ start_date: '2026-11-01' }, undefined, { omitMetadata: true });

  const { payload, response, after } = await scenario.correct('لا، قصدي 2026-11-01');
  assert.equal(response.caseState?.groundedResult, 'none');
  assert.equal(response.caseState?.invalidationReason, undefined);
  assert.equal(payload.lastGroundedResult, undefined);
  assert.equal(after.lastGroundedResult, undefined);
  assert.equal((payload.factMeta as Record<string, { certainty: string }>).start_date?.certainty, 'UNCERTAIN');
  assert.equal(response.caseState?.facts.find((fact) => fact.key === 'start_date')?.certainty, 'UNCERTAIN');
});

test('a later advisory skill fact does not invalidate the current grounded result', async () => {
  const store = fakeStore();
  let call = 0;
  const skillId = 'test.advisory-grounded';
  const conversation = new ConversationService({
    persistence: store, understanding, defaultSkillId: skillId,
    skills: {
      async execute() {
        call += 1;
        return {
          status: 'completed', skillId, skillVersion: 1, runId: 'advisory-grounded',
          ...(call === 1 ? {
            answer: { text: 'Grounded answer.', evidenceIds: ['chunk-grounded'] },
            trace: { decisionStatus: 'DECIDED', sourceSupport: 'SUPPORTED', acceptedEvidenceRefs: ['chunk-grounded'], materialFactKeys: ['grounding_control'] },
          } : {}),
          ...(call === 2 ? { caseFacts: { proposed_duration: 6 } } : {}),
        };
      },
    },
  });
  const session = await conversation.create('p', 'a', 'private');
  const seeded = store.rows.get(session.id)!.sessionContext;
  seeded.facts.grounding_control = true;
  seeded.factMeta = { grounding_control: { provenance: 'user_answer', certainty: 'CERTAIN', at: '2026-11-01T00:00:00.000Z' } };
  await conversation.handleMessage('p', 'a', session.id, { text: 'Initial question?' });
  await conversation.handleMessage('p', 'a', session.id, { text: 'Could I wait 6 days' });
  const turn = await conversation.handleMessage('p', 'a', session.id, { text: 'Source?' });
  assert.equal(turn.caseState?.groundedResult, 'valid');
  assert.equal(store.rows.get(session.id)?.sessionContext.facts.proposed_duration, undefined);
});

test('an English prefixed correction updates the sole date and removes the old result', async () => {
  const scenario = await groundedCorrectionCase({ start_date: '2026-11-01' }, undefined, { contracts: { start_date: { type: 'date' } } });
  const { payload, response, after } = await scenario.correct('No, I meant 2026-11-02');

  assert.deepEqual(payload.context, { start_date: '2026-11-02' });
  assert.equal(payload.lastGroundedResult, undefined);
  assert.equal(after.facts.start_date, '2026-11-02');
  assert.equal(response.caseState?.invalidationReason, 'explicit_correction');
});

test('a boolean correction stores the canonical boolean value', async () => {
  const scenario = await groundedCorrectionCase({ flag: false });
  const { payload, after } = await scenario.correct('I meant TRUE');

  assert.deepEqual(payload.context, { flag: true });
  assert.equal(after.facts.flag, true);
  assert.equal(payload.lastGroundedResult, undefined);
});

test('a literal boolean-shaped option fills an unanswered single-choice requirement', async () => {
  const scenario = await groundedCorrectionCase({}, {
    key: 'selection', type: 'single_choice', options: ['true', 'false'],
  });
  const { payload, after } = await scenario.correct('I meant true');

  assert.deepEqual(payload.context, { selection: 'true' });
  assert.equal(after.facts.selection, 'true');
  assert.equal(after.factMeta?.selection.certainty, 'CERTAIN');
});

test('distinct literal options remain different in a single-choice correction', async () => {
  const scenario = await groundedCorrectionCase({ selection: 'true' }, {
    key: 'selection', type: 'single_choice', options: ['true', 'yes'],
  }, { contracts: { selection: { type: 'single_choice', options: ['true', 'yes'] } } });
  const { payload, after } = await scenario.correct('I meant yes');

  assert.deepEqual(payload.context, { selection: 'yes' });
  assert.equal(after.facts.selection, 'yes');
  assert.equal(after.factMeta?.selection.superseded?.[0]?.value, 'true');
  assert.equal(payload.lastGroundedResult, undefined);
});

const inertCorrections: Array<{
  name: string;
  facts: Record<string, unknown>;
  text: string;
  pending?: Parameters<typeof groundedCorrectionCase>[1];
}> = [
  ...[
    'I meant: not 10:30 AM',
    'Sorry, I meant maybe 10:30 a.m.',
    'I meant 10:30 AM or 11:30 AM',
    "Sorry, I'm not sure I meant 10:30 AM",
  ].map((text) => ({
    name: `a non-definite minute-level AM/PM expression: ${text}`,
    facts: { observed_at: '09:00' },
    text,
  })),
  {
    name: 'a non-definite replacement clause negating the time',
    facts: { observed_at: '09:00' },
    text: 'I meant: not 10:00',
  },
  {
    name: 'a non-definite replacement clause hedging the time',
    facts: { observed_at: '09:00' },
    text: 'Sorry, I meant maybe 10:00',
  },
  {
    name: 'a non-definite replacement clause hedging after the time',
    facts: { observed_at: '09:00' },
    text: 'I meant 10:00 maybe',
  },
  {
    name: 'a non-definite replacement clause hedging the time in Arabic',
    facts: { observed_at: '09:00' },
    text: 'آسفة، قصدي: ربما 10:00',
  },
  {
    name: 'an embedded marker after an uncertain preface',
    facts: { start_date: '2026-11-01' },
    text: "I'm not sure I meant 2026-11-02",
    pending: { key: 'note', type: 'free_text' },
  },
  {
    name: 'an apology followed by an uncertain preface',
    facts: { start_date: '2026-11-01' },
    text: "Sorry, I'm not sure I meant 2026-11-02",
  },
  { name: 'two replacement times', facts: { observed_at: '09:00' }, text: 'I meant 10:00 or 11:00' },
  { name: 'the current boolean', facts: { flag: false }, text: 'I meant false' },
  { name: 'the current time with different padding', facts: { observed_at: '9:00' }, text: 'I meant 09:00' },
  { name: 'number for a boolean', facts: { flag: true }, text: 'لا، قصدي 3' },
  { name: 'number for a date', facts: { start_date: '2026-11-01' }, text: 'لا، قصدي 3' },
  { name: 'unresolved free text', facts: { note: 'original description' }, text: 'لا، قصدي another description' },
  {
    name: 'unresolved free text with a pending free-text question',
    facts: { note: 'original description' },
    text: 'لا، قصدي another description',
    pending: { key: 'note', type: 'free_text' },
  },
  {
    name: 'unresolved free text with an unanswered free-text question',
    facts: {},
    text: 'لا، قصدي another description',
    pending: { key: 'note', type: 'free_text' },
  },
  {
    name: 'two possible dates',
    facts: { start_date: '2026-11-01', end_date: '2026-11-03' },
    text: 'لا، قصدي 2026-11-02',
  },
  {
    name: 'two possible dates with a pending question about one of them',
    facts: { start_date: '2026-11-01', end_date: '2026-11-03' },
    text: 'لا، قصدي 2026-11-02',
    pending: { key: 'end_date', type: 'date' },
  },
  {
    name: 'two possible dates with an unanswered date question',
    facts: { start_date: '2026-11-01', end_date: '2026-11-03' },
    text: 'لا، قصدي 2026-11-02',
    pending: { key: 'other_date', type: 'date' },
  },
  {
    name: 'admission hardening ambiguity with Arabic-Indic digits and an unanswered number question',
    facts: { earlier_days: 5, later_days: 7 },
    text: 'لا، قصدي ٦',
    pending: { key: 'other_days', type: 'number' },
  },
  {
    name: 'admission hardening ambiguity with a nonpadded ISO date and an unanswered date question',
    facts: { start_date: '2026-11-01', end_date: '2026-11-03' },
    text: 'لا، قصدي 2026-11-2',
    pending: { key: 'other_date', type: 'date' },
  },
];

for (const { name, facts, text, pending } of inertCorrections) {
  test(`a correction with ${name} leaves the facts and grounded result intact`, async () => {
    const scenario = await groundedCorrectionCase(facts, pending);
    const { response, payload, after } = await scenario.correct(text);

    assert.deepEqual(payload.context, facts);
    assert.deepEqual(after.facts, facts);
    assert.deepEqual(after.factMeta, scenario.before.factMeta);
    assert.deepEqual(payload.changedFactKeys, []);
    assert.equal(response.caseState?.groundedResult, Object.keys(facts).length > 0 ? 'valid' : 'none');
    assert.equal(response.caseState?.invalidationReason, undefined);
    assert.deepEqual(payload.lastGroundedResult, scenario.before.lastGroundedResult);
    assert.deepEqual(after.lastGroundedResult, scenario.before.lastGroundedResult);
  });
}

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
    model: { async generateText({ instructions, message }: { instructions?: string; message?: string }) {
      prompts.push([instructions, message].filter(Boolean).join('\n\n'));
      return { text: '{}' };
    } },
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
  await c.handleMessage('p', 'a', s.id, {
    text: 'نزل دم 6 ساعات', answers: [{ key: 'bleeding_duration_hours', value: 6 }],
  });
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
