/**
 * B1.1 — MINIMUM NECESSARY QUESTIONING + MATERIALITY RE-EVALUATION — deterministic acceptance.
 *
 * Proves behaviours, not implementation details:
 *   K-1  UNKNOWN / non-CERTAIN never satisfies (and never silently disappears as known)
 *   K-2  an unverified knownFromCase claim cannot fabricate satisfaction
 *   K-5  an invented decision-path need cannot become a trusted question
 *   K-4  currently-material requirements are deliberately ordered; Core asks the first one
 *   K-3  stale persisted materiality is never continued from the B3a fast path
 *   §18  Core stays generic: ordered requirements → first unresolved askable → ONE question
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFiqhHaydSkill } from '../src/domain/naqaa/fiqh-hayd-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import type { DecisionRequirement, KnownContextItem } from '../src/core/readiness/readiness.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import type { UnderstandingResult } from '../src/core/understanding/understanding.ts';
import {
  APPROVED_SOURCE_TITLES,
  FIQH_HAYD_SKILL_ID,
  FIQH_HAYD_SKILL_VERSION,
  MATERIALITY_STABLE_NEEDS,
  NEED_CATALOGUE,
  isMaterialityStable,
} from '../src/domain/naqaa/fiqh-hayd-contracts.ts';

const APPROVED_ID = 'src-approved-1';
const C1 = 'chunk-1';
const C8 = 'chunk-8';
const readiness = new DecisionReadinessService();

const passage = (chunkId: string) => ({
  chunkId, documentId: 'doc-1', sourceId: APPROVED_ID, sourceTitle: APPROVED_SOURCE_TITLES[0],
  chunkIndex: 7, text: 'نص فقهي معتمد يوضح الشرط.', score: 0.03,
});

function knowledge(sourceIds: string[] = [APPROVED_ID]) {
  const calls = { searches: 0 };
  return {
    calls,
    async search({ sourceIds: wanted }: { sourceIds?: string[] }) {
      calls.searches += 1;
      const hits = [passage(C1)];
      return wanted ? hits.filter((h) => wanted.includes(h.sourceId)) : hits;
    },
    async resolveSources(titles: string[]) {
      return titles.includes(APPROVED_SOURCE_TITLES[0]) ? sourceIds.map((id) => ({ id, title: APPROVED_SOURCE_TITLES[0] })) : [];
    },
    async adjacent() { return [passage(C8)]; },
  };
}

function scriptedModel(responses: string[]) {
  const calls: string[] = [];
  return {
    calls,
    async generateText({ message }: { message?: string }) {
      calls.push(message ?? '');
      return { text: responses.shift() ?? '{}' };
    },
  };
}

const PLANNER = JSON.stringify({ issue: 'مسألة', queries: ['الصفرة والكدرة'] });
const requirement = (key: string, wording = 'سؤال بسيط؟', extra: Record<string, unknown> = {}) => ({
  key, whyMaterial: 'شرط في المصدر', question: { wording }, interaction: { type: 'yes_no' }, citations: [C1], ...extra,
});
const reasoningPlan = (requirements: unknown[]) => JSON.stringify({ interpretations: [], requirements, unresolved: [] });

async function runSkill(opts: {
  input?: Record<string, unknown>;
  model?: unknown;
  knowledge?: unknown;
}) {
  const skill = createFiqhHaydSkill({ readiness });
  return (await skill.execute({
    projectId: 'p1', actor: 'a1', input: opts.input ?? { text: 'حالة' },
    knowledge: opts.knowledge ?? knowledge(),
    model: opts.model ?? scriptedModel([PLANNER, reasoningPlan([])]),
  } as never)) as Record<string, unknown>;
}

/** Drive the REAL skill all the way to the decision step and return the validated outcome. */
async function runDecision(proposal: unknown, input: Record<string, unknown> = { text: 'حالة' }) {
  return runSkill({
    input,
    model: scriptedModel([PLANNER, reasoningPlan([]), JSON.stringify(proposal)]),
  });
}

const keysOf = (out: Record<string, unknown>) => (out.requirementKeys as string[]) ?? [];
const notesOf = (out: Record<string, unknown>) => {
  const ids = (out.trace as { notes?: string[] })?.notes ?? [];
  const gap = (out.sourceGap as { notes?: string[] })?.notes ?? [];
  return [...ids, ...gap];
};

// ===========================================================================
// K-1 — UNKNOWN (and any non-CERTAIN value) does not satisfy
// ===========================================================================

test('K-1/Test1: UNKNOWN does not satisfy — the need stays unresolved AND still askable', async () => {
  const out = await runSkill({
    input: {
      text: 'حالة',
      context: { bleeding_cessation: 'UNKNOWN' },
      factMeta: { bleeding_cessation: { certainty: 'UNKNOWN', provenance: 'user_answer' } },
    },
    model: scriptedModel([PLANNER, reasoningPlan([requirement('bleeding_cessation', 'هل توقف الدم؟')])]),
  });
  // The mere existence of an UNKNOWN value must not remove the need from the question set...
  assert.deepEqual(keysOf(out), ['bleeding_cessation'], 'the need is still material');
  // ...and it must not be treated as satisfied.
  assert.equal((out.readiness as { status: string }).status, 'NEEDS_INFORMATION');
  assert.equal(out.status, 'NEEDS_INFORMATION');
  assert.ok(notesOf(out).includes('unproven_known_from_case:bleeding_cessation') === false);
});

test('K-1/Test2: UNCERTAIN does not silently satisfy either', async () => {
  const out = await runSkill({
    input: {
      text: 'حالة',
      context: { bleeding_cessation: 'توقف تمامًا' },
      factMeta: { bleeding_cessation: { certainty: 'UNCERTAIN', provenance: 'user_answer' } },
    },
    model: scriptedModel([PLANNER, reasoningPlan([requirement('bleeding_cessation', 'هل توقف الدم؟')])]),
  });
  assert.deepEqual(keysOf(out), ['bleeding_cessation']);
  assert.equal((out.readiness as { status: string }).status, 'NEEDS_INFORMATION');
});

test('K-1 (control): a CERTAIN current value DOES satisfy and is not asked', async () => {
  const out = await runSkill({
    input: {
      text: 'حالة',
      context: { bleeding_cessation: 'توقف تمامًا' },
      factMeta: { bleeding_cessation: { certainty: 'CERTAIN', provenance: 'user_answer' } },
    },
    model: scriptedModel([PLANNER, reasoningPlan([requirement('bleeding_cessation', 'هل توقف الدم؟')])]),
  });
  assert.deepEqual(keysOf(out), [], 'a certain value legitimately satisfies the need');
  assert.ok(notesOf(out).includes('already_satisfied:bleeding_cessation'));
});

// ===========================================================================
// K-2 — knownFromCase cannot fabricate satisfaction
// ===========================================================================

test('K-2/Test3: an unverified knownFromCase claim cannot drop a material need', async () => {
  const out = await runSkill({
    model: scriptedModel([PLANNER, reasoningPlan([requirement('bleeding_cessation', 'هل توقف الدم؟', { knownFromCase: true })])]),
  });
  assert.deepEqual(keysOf(out), ['bleeding_cessation'], 'the need stays material');
  assert.equal((out.readiness as { status: string }).status, 'NEEDS_INFORMATION');
  assert.ok(notesOf(out).includes('unproven_known_from_case:bleeding_cessation'), 'the claim is recorded, not obeyed');
});

// ===========================================================================
// K-5 — an invented decision-path need can never become a question
// ===========================================================================

test('K-5/Test4: an INVENTED decision-path need is rejected, never asked, never trusted', async () => {
  const invented = 'invented_need_xyz';
  const out = await runDecision({
    status: 'NEEDS_INFORMATION',
    sourceSupport: 'PARTIAL',
    needsInformation: { key: invented, whyMaterial: 'x', question: { wording: 'سؤال مخترع؟' }, evidenceRefs: [C8] },
  });
  assert.equal(out.status, 'SOURCE_GAP', 'no ruling and no invented question');
  assert.deepEqual(keysOf(out), [], 'the invented need is not a trusted requirement');
  assert.equal(out.skillContext, undefined, 'nothing invented is persisted as pending');
  assert.ok(notesOf(out).some((n) => n.includes(`needs_information_unregistered_need:${invented}`)), 'the rejection is observable');
  // The invented need must never become a QUESTION: no interaction, no wording, no requirement
  // key — while the rejection itself stays observable in the trace (the point of the note).
  assert.equal(out.interaction, undefined);
  assert.equal(JSON.stringify(out).includes('سؤال مخترع'), false, 'no invented question is rendered');
  assert.equal((out.trace as { requirementKeys?: string[] }).requirementKeys?.includes(invented) ?? false, false);
  assert.equal((out.answer as { text?: string })?.text?.includes(invented) ?? false, false);
});

test('K-5 (control): a REGISTERED decision-path need is still accepted normally', async () => {
  const out = await runDecision({
    status: 'NEEDS_INFORMATION',
    sourceSupport: 'PARTIAL',
    needsInformation: { key: 'bleeding_contiguity', whyMaterial: 'شرط الاتصال', question: { wording: 'هل كان متصلًا؟' }, evidenceRefs: [C8] },
  });
  assert.equal(out.status, 'NEEDS_INFORMATION');
  assert.deepEqual(keysOf(out), ['bleeding_contiguity']);
  const ctx = out.skillContext as { requirements: DecisionRequirement[] };
  assert.equal(ctx.requirements[0].key, 'bleeding_contiguity');
});

// ===========================================================================
// K-4 — deliberate ordering, preserved; Core asks the first one
// ===========================================================================

test('K-4/Test5: the emitted order IS the semantic order, and Core asks the first unresolved', async () => {
  const out = await runSkill({
    model: scriptedModel([PLANNER, reasoningPlan([
      requirement('postpartum_state', 'هل الحالة بعد ولادة؟'), // branch-defining → first
      requirement('habit_days', 'كم عادتك؟'),                   // refinement → later
    ])]),
  });
  assert.deepEqual(keysOf(out), ['postpartum_state', 'habit_days'], 'Core does not reorder the Skill’s deliberate order');

  const ctx = out.skillContext as { requirements: DecisionRequirement[] };
  assert.deepEqual(ctx.requirements.map((r) => r.key), ['postpartum_state', 'habit_days'], 'the persisted order matches');

  // Core's selection is positional: the FIRST unresolved askable requirement, exactly one question.
  const r = readiness.evaluate({ requirements: ctx.requirements, known: [] });
  assert.equal(r.missing[0].key, 'postpartum_state');
  assert.equal(r.nextQuestion?.key, 'postpartum_state');
});

test('K-4/Test8: exactly ONE question is rendered, and it is the first unresolved askable need', async () => {
  const store = (() => {
    const rows = new Map<string, ConversationSession>();
    return { rows, async create(s: ConversationSession) { rows.set(s.id, s); return s; },
      async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
      async save(s: ConversationSession) { rows.set(s.id, s); return s; } };
  })();
  const requirements: DecisionRequirement[] = [
    { key: 'first_need', description: 'd1', material: true, question: { key: 'first_need', wording: 'سؤال أول؟' }, interaction: { type: 'yes_no' } },
    { key: 'second_need', description: 'd2', material: true, question: { key: 'second_need', wording: 'سؤال ثانٍ؟' }, interaction: { type: 'yes_no' } },
  ];
  const service = new ConversationService({
    persistence: store,
    understanding: { evaluate: async ({ text }: { text: string }): Promise<UnderstandingResult> => ({
      status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'ar', issues: [text], references: { resolved: true },
      corrections: [], facts: [], candidates: [], ambiguity: { material: false },
      contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] } }) },
    skills: { execute: async () => ({ status: 'needs_information' as const, skillId: 'x', skillVersion: 1, runId: 'r', readiness: readiness.evaluate({ requirements, known: [] }) }) },
    defaultSkillId: 'x',
  });
  const s = await service.create('p', 'a', 'private');
  const t = await service.handleMessage('p', 'a', s.id, { text: 'حالة' });
  assert.equal(t.status, 'needs_information');
  assert.equal(t.interaction?.key, 'first_need', 'the FIRST unresolved requirement is asked');
  assert.equal(t.message, t.interaction?.question, 'the rendered message IS that one question');
  assert.equal(typeof t.interaction, 'object');
  assert.deepEqual(t.readiness?.missingKeys, ['first_need', 'second_need'], 'the rest stay reported, never asked together');
});

// ===========================================================================
// K-3 — B3a must not continue stale materiality
// ===========================================================================

test('K-3/Test6: a stale persisted requirement is NOT continued — fresh derivation decides', async () => {
  const stale = {
    skillId: FIQH_HAYD_SKILL_ID, skillVersion: FIQH_HAYD_SKILL_VERSION, issueSignature: 'sig',
    requirements: [
      { key: 'bleeding_cessation', description: 'd', material: true, question: { key: 'bleeding_cessation', wording: 'هل توقف؟' }, interaction: { type: 'yes_no' } },
      { key: 'bleeding_duration_hours', description: 'd', material: true, question: { key: 'bleeding_duration_hours', wording: 'كم ساعة؟' }, interaction: { type: 'number' } },
    ],
    evidenceRefs: [C1], sourceIds: [APPROVED_ID], baseCaseSignature: 'base', at: new Date().toISOString(),
  };
  // The answer to A (a materiality-UNSTABLE need) could have changed which needs apply, so the
  // stored list may not be trusted: the Skill must re-derive. The fresh derivation asks something
  // entirely different (and no longer includes the stale pair).
  const model = scriptedModel([PLANNER, reasoningPlan([requirement('postpartum_state', 'هل الحالة بعد ولادة؟')])]);
  const out = await runSkill({
    input: {
      text: 'نعم', pendingKey: 'bleeding_cessation',
      answeredKeys: ['bleeding_cessation'], changedFactKeys: ['bleeding_cessation'], correctionsPresent: false,
      context: { bleeding_cessation: 'توقف تمامًا' },
      factMeta: { bleeding_cessation: { certainty: 'CERTAIN', provenance: 'user_answer' } },
      skillContext: stale,
    },
    model,
  });
  assert.equal(model.calls.length, 2, 'the full derivation ran (planner + interpreter)');
  assert.ok(notesOf(out).includes('b1.1_materiality_stability_unproven'), 'the fallback reason is recorded');
  assert.deepEqual(keysOf(out), ['postpartum_state'], 'the FRESH requirements replace the stale ones');
  assert.equal(keysOf(out).includes('bleeding_cessation'), false, 'the stale need is not continued');
  assert.equal(keysOf(out).includes('bleeding_duration_hours'), false, 'the stale need is not continued');
  assert.equal((out.trace as { plannerCalled?: boolean }).plannerCalled, true, 'a full derivation, not reuse');
});

/**
 * The B3a reuse GATE is still reached for every one of these — the architecture is intact — but it
 * is DECLINED, so the stored list is never continued. This is the §9A proof class: an accepted
 * answer to a removed / unclassified need must fall through to the existing full derivation.
 */
const removedNeedAnswers: Array<[string, unknown]> = [
  ['habit_days', 7],
  ['cycle_interval_days', 28],
  ['discharge_colour', 'أحمر'],
  ['bleeding_cessation', true],
];

test('B1.1 closure/§9A: an accepted answer to an unproven need never reuses the stored list', async () => {
  for (const [key, value] of removedNeedAnswers) {
    assert.equal(isMaterialityStable(key), false, `${key} is not proven materiality-stable`);
    const stored = {
      skillId: FIQH_HAYD_SKILL_ID, skillVersion: FIQH_HAYD_SKILL_VERSION, issueSignature: 'sig',
      requirements: [
        { key, description: 'd', material: true, question: { key, wording: 'سؤال؟' }, interaction: { type: 'number' } },
        { key: 'bleeding_duration_days', description: 'd', material: true, question: { key: 'bleeding_duration_days', wording: 'كم يومًا؟' }, interaction: { type: 'number' } },
      ],
      evidenceRefs: [C1], sourceIds: [APPROVED_ID], baseCaseSignature: 'base', at: new Date().toISOString(),
    };
    const model = scriptedModel([PLANNER, reasoningPlan([requirement('age_eligibility', 'هل بلغتِ سن التكليف؟')])]);
    const out = await runSkill({
      input: {
        text: String(value), pendingKey: key,
        answeredKeys: [key], changedFactKeys: [key], correctionsPresent: false,
        context: { [key]: value },
        factMeta: { [key]: { certainty: 'CERTAIN', provenance: 'user_answer' } },
        skillContext: stored,
      },
      model,
    });
    assert.equal(model.calls.length, 2, `${key}: the full derivation ran (planner + interpreter)`);
    assert.ok(notesOf(out).includes('b1.1_materiality_stability_unproven'), `${key}: the refusal is recorded`);
    assert.equal(notesOf(out).includes('b3a_reused_context'), false, `${key}: no stale reuse`);
    assert.equal((out.trace as { plannerCalled?: boolean }).plannerCalled, true, `${key}: planner re-ran`);
    assert.deepEqual(keysOf(out), ['age_eligibility'], `${key}: fresh requirements replace the stored list`);
    assert.equal(keysOf(out).includes('bleeding_duration_days'), false, `${key}: the stale need is not continued`);
  }
});

test('B1.1 closure: the proven-safe set is EMPTY and every Naqaa need refuses reuse', () => {
  // Not a default: an empty set is the proven outcome of the closure inspection.
  assert.equal(MATERIALITY_STABLE_NEEDS.size, 0, 'no Naqaa need is positively proven materiality-stable');
  for (const key of Object.keys(NEED_CATALOGUE)) {
    assert.equal(isMaterialityStable(key), false, `${key} must fall back to a fresh derivation`);
  }
  assert.equal(isMaterialityStable('not_a_known_need'), false, 'unknown keys stay fail-safe');
});

// ===========================================================================
// §12 / §C — asked ≠ satisfied; existing information is used before asking
// ===========================================================================

test('Test9: interaction history alone can never satisfy a need', () => {
  const reqs: DecisionRequirement[] = [{ key: 'a', description: 'A', material: true, question: { key: 'a', wording: 'سؤال أ؟' } }];
  // A UX target / question count is not satisfaction — the requirement stays unresolved.
  const r = readiness.evaluate({ requirements: reqs, known: [], questionsAsked: 9, targetQuestions: 1 });
  assert.equal(r.status, 'NEEDS_INFORMATION');
  assert.equal(r.missing[0].key, 'a');
  // Neither is a non-CERTAIN value (the conversation stores an explicit "I don't know" as UNKNOWN).
  const nonCertain: KnownContextItem[] = [
    { key: 'a', value: 'UNKNOWN', source: 'conversation', certainty: 'UNKNOWN' },
    { key: 'a', value: 'maybe', source: 'conversation', certainty: 'UNCERTAIN' },
  ];
  for (const known of nonCertain) {
    assert.equal(readiness.evaluate({ requirements: reqs, known: [known] }).status, 'NEEDS_INFORMATION');
  }
});

test('Test10: a trustworthy CERTAIN current fact avoids the duplicate question', () => {
  const reqs: DecisionRequirement[] = [
    { key: 'a', description: 'A', material: true, question: { key: 'a', wording: 'سؤال أ؟' } },
    { key: 'b', description: 'B', material: true, question: { key: 'b', wording: 'سؤال ب؟' } },
  ];
  const known: KnownContextItem[] = [{ key: 'a', value: 6, source: 'conversation', certainty: 'CERTAIN' }];
  const r = readiness.evaluate({ requirements: reqs, known });
  assert.deepEqual(r.missing.map((m) => m.key), ['b'], 'the known need is never asked');
  assert.deepEqual(r.satisfied, ['a']);
});

// ===========================================================================
// §18 — the generic Core proof: no domain knowledge in Core
// ===========================================================================

test('§18 generic: ordered requirements → first unresolved askable → ONE question (no domain keys)', () => {
  const requirements: DecisionRequirement[] = [
    { key: 'alpha', description: 'A', material: true, question: { key: 'alpha', wording: 'alpha?' } },
    { key: 'beta', description: 'B', material: true, question: { key: 'beta', wording: 'beta?' } },
    { key: 'gamma', description: 'C', material: false },
  ];
  const none = readiness.evaluate({ requirements, known: [] });
  assert.equal(none.status, 'NEEDS_INFORMATION');
  assert.equal(none.nextQuestion?.key, 'alpha', 'the skill-owned order decides, positionally');
  assert.deepEqual(none.missing.map((m) => m.key), ['alpha', 'beta'], 'only material gaps are reported');
  assert.equal(none.missing.length > 1 && Boolean(none.nextQuestion), true, 'many missing → exactly one question');

  const partially = readiness.evaluate({ requirements, known: [{ key: 'alpha', value: 'x', source: 'conversation', certainty: 'CERTAIN' }] });
  assert.equal(partially.nextQuestion?.key, 'beta', 'the known one is skipped, order preserved');

  const all = readiness.evaluate({ requirements, known: [
    { key: 'alpha', value: 'x', source: 'conversation', certainty: 'CERTAIN' },
    { key: 'beta', value: 2, source: 'conversation', certainty: 'CERTAIN' },
  ] });
  assert.equal(all.status, 'READY_FOR_DECISION', 'non-material gaps never block');
  assert.equal(all.nextQuestion, undefined, 'nothing is asked when nothing is missing');
});
