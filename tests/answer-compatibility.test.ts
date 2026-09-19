/**
 * B1.0 — EXPECTED-ANSWER COMPATIBILITY — deterministic acceptance suite.
 *
 * Proves the invariant: a pending key can NEVER, by itself, authorize an arbitrary fact. Only a
 * candidate proven compatible with the requirement's OWN contract may become a CERTAIN fact.
 *
 * Two levels:
 *   1. the generic Core contract (no domain knowledge at all), and
 *   2. the real production stack: real ConversationService → real contract-faithful skill output
 *      (whose requirement contracts are the Skill-owned canonical ones).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { validateAnswerCompatibility } from '../src/core/readiness/readiness.ts';
import type { DecisionRequirement, RequirementInteraction } from '../src/core/readiness/readiness.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import type { UnderstandingResult } from '../src/core/understanding/understanding.ts';

import { createFiqhHaydSkill } from '../src/domain/naqaa/fiqh-hayd-skill.ts';
import { APPROVED_SOURCE_TITLES, NEED_CATALOGUE, canonicalInteractionFor } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';

// ===========================================================================
// 1. GENERIC CORE — the validator knows NOTHING about any domain (§21)
// ===========================================================================

test('core: the compatibility validator is domain-neutral (only ACCEPTED is provable)', () => {
  // yes_no: a boolean is provable, a number is a definite mismatch, prose is unprovable.
  assert.equal(validateAnswerCompatibility({ type: 'yes_no' }, true), 'ACCEPTED');
  assert.equal(validateAnswerCompatibility({ type: 'yes_no' }, false), 'ACCEPTED');
  assert.equal(validateAnswerCompatibility({ type: 'yes_no' }, 5), 'REJECTED');
  assert.equal(validateAnswerCompatibility({ type: 'yes_no' }, 'some prose'), 'UNKNOWN');

  // number / duration
  assert.equal(validateAnswerCompatibility({ type: 'number' }, 5), 'ACCEPTED');
  assert.equal(validateAnswerCompatibility({ type: 'number' }, true), 'REJECTED');
  assert.equal(validateAnswerCompatibility({ type: 'duration' }, 6), 'ACCEPTED');

  // bounded categorical
  assert.equal(validateAnswerCompatibility({ type: 'single_choice', options: ['a', 'b'] }, 'a'), 'ACCEPTED');
  assert.equal(validateAnswerCompatibility({ type: 'single_choice', options: ['a', 'b'] }, 'z'), 'REJECTED');
  assert.equal(validateAnswerCompatibility({ type: 'single_choice', options: ['a', 'b'], allowOther: true }, 'z'), 'UNKNOWN');
  // missing allowed values = insufficient contract, never permission
  assert.equal(validateAnswerCompatibility({ type: 'single_choice', options: [] }, 'a'), 'UNKNOWN');

  // an absent / malformed contract can never authorize certainty
  assert.equal(validateAnswerCompatibility(undefined, 'anything'), 'UNKNOWN');
  assert.equal(validateAnswerCompatibility({ type: 'not_a_type' } as unknown as RequirementInteraction, 'x'), 'UNKNOWN');

  // an explicitly declared free text is permissive by intent; an empty candidate never is
  assert.equal(validateAnswerCompatibility({ type: 'free_text' }, 'an observation'), 'ACCEPTED');
  assert.equal(validateAnswerCompatibility({ type: 'free_text' }, ''), 'REJECTED');
  assert.equal(validateAnswerCompatibility({ type: 'yes_no' }, ''), 'REJECTED');
});

test('core: a structured answer is validated exactly like a typed one (no bypass)', () => {
  const yesNo: RequirementInteraction = { type: 'yes_no' };
  assert.equal(validateAnswerCompatibility(yesNo, 3), 'REJECTED');       // { key: 3 }
  assert.equal(validateAnswerCompatibility(yesNo, '3'), 'UNKNOWN');      // cannot be proven
  assert.equal(validateAnswerCompatibility(yesNo, true), 'ACCEPTED');    // the real answer
});

// ===========================================================================
// 2. DOMAIN CONTRACT — the Skill owns a known need's answer kind (§17 / G1)
// ===========================================================================

const APPROVED_ID = 'src-approved-1';

const passage = (chunkId: string, text: string) => ({
  chunkId, documentId: 'doc-1', sourceId: APPROVED_ID, sourceTitle: APPROVED_SOURCE_TITLES[0],
  chunkIndex: 7, text, score: 0.03,
});

function fakeKnowledge() {
  return {
    async search({ sourceIds }: { query: string; topK?: number; sourceIds?: string[] }) {
      const hits = [passage('chunk-7', 'نص فقهي معتمد يوضح الشرط.')];
      return sourceIds ? hits.filter((h) => sourceIds.includes(h.sourceId)) : hits;
    },
    async resolveSources(titles: string[]) {
      return titles.includes(APPROVED_SOURCE_TITLES[0]) ? [{ id: APPROVED_ID, title: APPROVED_SOURCE_TITLES[0] }] : [];
    },
    async adjacent() { return []; },
  };
}

const planner = JSON.stringify({ issue: 'مسألة', queries: ['الصفرة والكدرة'] });

/** Run the REAL skill with a scripted model whose requirement declaration we control. */
async function runSkillWithDeclaredInteraction(key: string, declared: RequirementInteraction, opts: { knownFromCase?: boolean } = {}) {
  const responses = [
    planner,
    JSON.stringify({
      interpretations: [],
      requirements: [{
        key,
        whyMaterial: 'شرط في المصدر',
        question: { wording: 'سؤال بسيط؟' },
        interaction: declared,
        citations: ['chunk-7'],
        ...(opts.knownFromCase ? { knownFromCase: true } : {}),
      }],
      unresolved: [],
    }),
  ];
  let i = 0;
  const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
  const out = (await skill.execute({
    projectId: 'p1', actor: 'a1', input: { text: 'حالة' },
    knowledge: fakeKnowledge(),
    model: { async generateText() { return { text: responses[i++] ?? '{}' }; } },
  } as never)) as Record<string, unknown>;
  return out;
}

const requirementFor = (out: Record<string, unknown>, key: string) => {
  const ctx = out.skillContext as { requirements: DecisionRequirement[] } | undefined;
  return ctx?.requirements.find((r) => r.key === key);
};

test('G1: a model-declared NUMBER cannot redefine a known need whose answer is YES/NO', async () => {
  assert.equal(canonicalInteractionFor('postpartum_state')?.type, 'yes_no');
  const out = await runSkillWithDeclaredInteraction('postpartum_state', { type: 'number' });
  assert.equal(out.status, 'NEEDS_INFORMATION');
  assert.equal(requirementFor(out, 'postpartum_state')?.interaction?.type, 'yes_no', 'the Skill-owned kind wins');
});

test('G1: a model-declared YES/NO cannot redefine a known need whose answer is NUMERIC', async () => {
  assert.equal(canonicalInteractionFor('bleeding_duration_hours')?.type, 'number');
  const out = await runSkillWithDeclaredInteraction('bleeding_duration_hours', { type: 'yes_no' });
  assert.equal(requirementFor(out, 'bleeding_duration_hours')?.interaction?.type, 'number');
});

test('G3: a bounded categorical keeps its CANONICAL allowed values, not the model\'s', async () => {
  const canonical = canonicalInteractionFor('discharge_colour');
  assert.equal(canonical?.type, 'single_choice');
  assert.ok((canonical?.options ?? []).length > 0, 'the domain declares trustworthy allowed values');

  const out = await runSkillWithDeclaredInteraction('discharge_colour', {
    type: 'single_choice',
    options: ['قيمة من النموذج'],
    allowOther: false,
  });
  const produced = requirementFor(out, 'discharge_colour')?.interaction;
  assert.deepEqual(produced?.options, canonical?.options, 'the canonical allowed values survive');
  assert.equal(produced?.allowOther, true);
});

test('every known catalogue need declares a canonical expected-answer contract', () => {
  for (const key of Object.keys(NEED_CATALOGUE)) {
    const interaction = canonicalInteractionFor(key);
    assert.ok(interaction, `${key} must have a canonical contract`);
    if (interaction!.type === 'single_choice') assert.ok((interaction!.options ?? []).length > 0, `${key} needs bounded values`);
  }
  // an unknown identity has NO contract — never a permissive default
  assert.equal(canonicalInteractionFor('not_a_known_need'), undefined);
});

// ===========================================================================
// 3. CONVERSATION BINDING — the real stack (§11–§14, §18, §19, §22)
// ===========================================================================

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
    async save(s: ConversationSession) { rows.set(s.id, s); return s; },
  };
}

const understanding = (corrections: Array<{ target?: string; new: string }> = [], correctionsOnTurn = 0) => {
  let turn = 0;
  return {
    evaluate: async ({ text }: { text: string }): Promise<UnderstandingResult> => {
      turn += 1;
      // A correction is reported by the turn that carries it — never replayed on every turn.
      const active = correctionsOnTurn === 0 || turn === correctionsOnTurn ? corrections : [];
      return {
        status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'ar', issues: [text], references: { resolved: true },
        corrections: active, facts: [], candidates: [], ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      };
    },
  };
};

/**
 * A contract-faithful skill: it ASKS the given needs (carrying each need's Skill-owned canonical
 * contract) and is satisfied only by a KNOWN, CERTAIN value — exactly like the production skill.
 */
const SKILL_ID = 'test.answer-contract';

function contractSkill(keys: string[], opts: { interaction?: boolean } = {}) {
  const requirements: DecisionRequirement[] = keys.map((k) => ({
    key: k, description: k, material: true, question: { key: k, wording: `سؤال ${k}؟` },
    ...(opts.interaction === false ? {} : { interaction: canonicalInteractionFor(k) }),
  }));
  const readiness = new DecisionReadinessService();
  // The persisted B3a turn context: exactly how the production skill carries each requirement's
  // expected-answer contract to the turns that answer it.
  const turnContext = {
    skillId: SKILL_ID, skillVersion: 1, issueSignature: 'issue-sig',
    requirements, evidenceRefs: ['c1'], sourceIds: ['s1'],
    baseCaseSignature: 'base-sig', at: new Date().toISOString(),
  };
  return {
    execute: async (input: { payload?: unknown }) => {
      const p = (input.payload ?? {}) as { context?: Record<string, unknown>; factMeta?: Record<string, { certainty?: string }> };
      const facts = p.context ?? {};
      const meta = p.factMeta ?? {};
      const known = Object.entries(facts)
        .filter(([k, v]) => requirements.some((r) => r.key === k) && v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => ({ key: k, value: v, source: 'conversation' as const, ...(meta[k]?.certainty ? { certainty: meta[k]!.certainty as never } : {}) }));
      const r = readiness.evaluate({ requirements, known });
      if (r.status !== 'READY_FOR_DECISION') {
        return { status: 'needs_information' as const, skillId: SKILL_ID, skillVersion: 1, runId: 'r', readiness: r, skillContext: turnContext };
      }
      return {
        status: 'completed' as const, skillId: SKILL_ID, skillVersion: 1, runId: 'r', readiness: r,
        answer: { text: 'تم.', evidenceIds: ['c1'] },
        trace: { decisionStatus: 'DECIDED', decisionLabel: 'تم', acceptedEvidenceRefs: ['c1'] },
      };
    },
  };
}

function svc(
  store: ReturnType<typeof fakeStore>,
  skill: unknown,
  opts: { corrections?: Array<{ target?: string; new: string }>; correctionsOnTurn?: number; interactionsFor?: boolean } = {},
) {
  return new ConversationService({
    persistence: store,
    understanding: understanding(opts.corrections, opts.correctionsOnTurn ?? 0) as never,
    skills: skill as never,
    defaultSkillId: 'test.answer-contract',
    ...(opts.interactionsFor === false ? {} : { interactionsFor: () => ({}) }),
  });
}

const factOf = (store: ReturnType<typeof fakeStore>, id: string, key: string) => store.rows.get(id)!.sessionContext.facts[key];
const metaOf = (store: ReturnType<typeof fakeStore>, id: string, key: string) => store.rows.get(id)!.sessionContext.factMeta?.[key];

/** Turn 1 asks the need; turn 2 sends the free-text answer under test. */
async function askThenAnswer(key: string, text: string, opts: { corrections?: Array<{ target?: string; new: string }> } = {}) {
  const store = fakeStore();
  const c = svc(store, contractSkill([key]), opts);
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  const t2 = await c.handleMessage('p', 'a', s.id, { text });
  return { store, id: s.id, t1, t2 };
}

/** Turn 1 asks the need; turn 2 sends a STRUCTURED answer under test. */
async function askThenStructuredAnswer(key: string, value: unknown) {
  const store = fakeStore();
  const c = svc(store, contractSkill([key]));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  const t2 = await c.handleMessage('p', 'a', s.id, { text: 'إجابة', answers: [{ key, value }] });
  return { store, id: s.id, t2 };
}

// ---------------------------------------------------------------- §18 ------

test('postpartum_state: "نعم" is ACCEPTED as a normal ANSWER fact; "3" is REJECTED', async () => {
  const yes = await askThenAnswer('postpartum_state', 'نعم');
  assert.equal(factOf(yes.store, yes.id, 'postpartum_state'), true);
  assert.equal(metaOf(yes.store, yes.id, 'postpartum_state')?.certainty, 'CERTAIN');
  assert.equal(metaOf(yes.store, yes.id, 'postpartum_state')?.provenance, 'user_answer');

  const no = await askThenAnswer('postpartum_state', 'لا');
  assert.equal(factOf(no.store, no.id, 'postpartum_state'), false);

  // A NUMBER for a yes/no need is a definite mismatch: no fact at all, no certainty.
  const three = await askThenAnswer('postpartum_state', '3');
  assert.equal(factOf(three.store, three.id, 'postpartum_state'), undefined, 'no fact is written');
  assert.equal(metaOf(three.store, three.id, 'postpartum_state'), undefined);
  assert.equal(three.t2.status, 'needs_information', 'the need stays open');
});

test('postpartum_state: a structured number is REJECTED (structure is not authorization)', async () => {
  const r = await askThenStructuredAnswer('postpartum_state', 3);
  assert.equal(factOf(r.store, r.id, 'postpartum_state'), undefined);
  assert.equal(metaOf(r.store, r.id, 'postpartum_state'), undefined);
});

test('discharge_colour: a canonical category is ACCEPTED; "نعم" and structured true are REJECTED', async () => {
  const canonical = canonicalInteractionFor('discharge_colour')!;
  const colour = canonical.options![0];

  const ok = await askThenAnswer('discharge_colour', colour);
  assert.equal(factOf(ok.store, ok.id, 'discharge_colour'), colour);
  assert.equal(metaOf(ok.store, ok.id, 'discharge_colour')?.certainty, 'CERTAIN');

  // A boolean can never become a colour category.
  const asBool = await askThenAnswer('discharge_colour', 'نعم');
  assert.notEqual(factOf(asBool.store, asBool.id, 'discharge_colour'), true);
  assert.equal(metaOf(asBool.store, asBool.id, 'discharge_colour'), undefined);

  const structuredTrue = await askThenStructuredAnswer('discharge_colour', true);
  assert.notEqual(factOf(structuredTrue.store, structuredTrue.id, 'discharge_colour'), true);
  assert.equal(metaOf(structuredTrue.store, structuredTrue.id, 'discharge_colour'), undefined);
});

test('discharge_colour: an out-of-domain colour is never invented into a canonical value', async () => {
  const outOfDomain = 'وردي';
  assert.equal(canonicalInteractionFor('discharge_colour')!.options!.includes(outOfDomain), false);
  const r = await askThenAnswer('discharge_colour', outOfDomain);
  const meta = metaOf(r.store, r.id, 'discharge_colour');
  // allowOther keeps it recorded as NON-certain: the need stays open, no category invented.
  assert.notEqual(meta?.certainty, 'CERTAIN');
  assert.equal(r.t2.status, 'needs_information');
});

test('bleeding_duration_hours: "6" and "٦" are ACCEPTED; "نعم" is REJECTED', async () => {
  const ascii = await askThenAnswer('bleeding_duration_hours', '6');
  assert.equal(factOf(ascii.store, ascii.id, 'bleeding_duration_hours'), 6);
  assert.equal(metaOf(ascii.store, ascii.id, 'bleeding_duration_hours')?.certainty, 'CERTAIN');

  const arabic = await askThenAnswer('bleeding_duration_hours', '٦');
  assert.equal(factOf(arabic.store, arabic.id, 'bleeding_duration_hours'), 6, 'existing digit normalization');

  const boolean = await askThenAnswer('bleeding_duration_hours', 'نعم');
  assert.equal(factOf(boolean.store, boolean.id, 'bleeding_duration_hours'), undefined);
});

test('UNKNOWN: an explicit "ما أدري" never becomes a CERTAIN fact', async () => {
  const r = await askThenAnswer('postpartum_state', 'ما أدري');
  const meta = metaOf(r.store, r.id, 'postpartum_state');
  assert.equal(meta?.certainty, 'UNKNOWN');
  assert.notEqual(meta?.certainty, 'CERTAIN');
  assert.equal(r.t2.status, 'needs_information', 'the need is preserved as unresolved');
});

// ------------------------------------------------------- §11/§12/§22 ------

test('INVARIANT: a pending key with NO trustworthy contract cannot authorize a fact', async () => {
  const store = fakeStore();
  // The skill asks a need but carries NO contract, and the conversation has no static hints.
  const c = svc(store, contractSkill(['postpartum_state'], { interaction: false }), { interactionsFor: false });
  const s = await c.create('p', 'a', 'private');
  const t1 = await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  assert.equal(store.rows.get(s.id)!.sessionContext.pendingKey, 'postpartum_state');

  // "نعم" would be perfectly compatible — but compatibility cannot be PROVEN without a contract,
  // so inability to validate must not authorize certainty.
  const t2 = await c.handleMessage('p', 'a', s.id, { text: 'نعم' });
  assert.notEqual(metaOf(store, s.id, 'postpartum_state')?.certainty, 'CERTAIN');
  assert.equal(t2.status, 'needs_information');
  assert.equal(t1.status, 'needs_information');

  // the same holds for a structured answer: structure is never an authorization
  const t3 = await c.handleMessage('p', 'a', s.id, { text: 'إجابة', answers: [{ key: 'postpartum_state', value: true }] });
  assert.notEqual(metaOf(store, s.id, 'postpartum_state')?.certainty, 'CERTAIN');
  assert.equal(t3.status, 'needs_information');
});

test('an EXPLICIT free-text contract is permissive (declared text is not the same as missing)', async () => {
  const store = fakeStore();
  const freeText: DecisionRequirement = { key: 'free_note', description: 'x', material: true, question: { key: 'free_note', wording: 'اكتبي وصفك؟' }, interaction: { type: 'free_text' } };
  const skill = {
    execute: async (input: { payload?: unknown }) => {
      const p = (input.payload ?? {}) as { context?: Record<string, unknown>; factMeta?: Record<string, { certainty?: string }> };
      const v = (p.context ?? {}).free_note;
      const known = v !== undefined && v !== null && String(v).trim() !== '' && (p.factMeta?.free_note?.certainty ?? 'CERTAIN') === 'CERTAIN'
        ? [{ key: 'free_note', value: v, source: 'conversation' as const }] : [];
      const r = new DecisionReadinessService().evaluate({ requirements: [freeText], known });
      const ctx = {
        skillId: SKILL_ID, skillVersion: 1, issueSignature: 'free-sig',
        requirements: [freeText], evidenceRefs: ['c1'], sourceIds: ['s1'],
        baseCaseSignature: 'base-sig', at: new Date().toISOString(),
      };
      return r.status === 'READY_FOR_DECISION'
        ? { status: 'completed' as const, skillId: SKILL_ID, skillVersion: 1, runId: 'r', readiness: r }
        : { status: 'needs_information' as const, skillId: SKILL_ID, skillVersion: 1, runId: 'r', readiness: r, skillContext: ctx };
    },
  };
  const c = svc(store, skill);
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'ابدأ' });
  const t2 = await c.handleMessage('p', 'a', s.id, { text: 'وصف حر مفصل' });
  assert.equal(metaOf(store, s.id, 'free_note')?.certainty, 'CERTAIN');
  assert.equal(t2.status, 'completed');
});

// ---------------------------------------------------------------- §19 ------

test('EXISTING FACT PROTECTION: an incompatible candidate never overwrites a valid fact', async () => {
  const store = fakeStore();
  // Two needs: answering the first leaves the turn context — and therefore the contract — in place.
  const c = svc(store, contractSkill(['postpartum_state', 'bleeding_duration_hours']));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });

  // 1. a VALID answer establishes the fact
  await c.handleMessage('p', 'a', s.id, { text: 'نعم', answers: [{ key: 'postpartum_state', value: true }] });
  assert.equal(factOf(store, s.id, 'postpartum_state'), true);
  assert.equal(metaOf(store, s.id, 'postpartum_state')?.certainty, 'CERTAIN');

  // 2. an INCOMPATIBLE answer arrives for that same fact, while its contract is known
  const t3 = await c.handleMessage('p', 'a', s.id, { text: 'إجابة', answers: [{ key: 'postpartum_state', value: 3 }] });

  const meta = metaOf(store, s.id, 'postpartum_state');
  assert.equal(factOf(store, s.id, 'postpartum_state'), true, 'the valid fact is intact');
  assert.equal(meta?.certainty, 'CERTAIN', 'certainty is untouched');
  assert.equal(meta?.at, metaOf(store, s.id, 'postpartum_state')?.at);
  assert.equal(t3.caseState?.invalidationReason, undefined, 'a rejected candidate causes no invalidation');
});

test('CORRECTIONS cannot bypass validation: an incompatible correction is inert', async () => {
  const store = fakeStore();
  // The understanding reports a correction that is NOT compatible with the typed fact.
  const c = svc(store, contractSkill(['postpartum_state', 'bleeding_duration_hours']), { corrections: [{ target: 'postpartum_state', new: '3' }], correctionsOnTurn: 3 });
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  await c.handleMessage('p', 'a', s.id, { text: 'نعم', answers: [{ key: 'postpartum_state', value: true }] });
  assert.equal(factOf(store, s.id, 'postpartum_state'), true);

  const t3 = await c.handleMessage('p', 'a', s.id, { text: 'لا، قصدي 3' });
  assert.equal(factOf(store, s.id, 'postpartum_state'), true, 'the valid fact survives an incompatible correction');
  assert.equal(metaOf(store, s.id, 'postpartum_state')?.superseded, undefined);
  assert.equal(t3.caseState?.invalidationReason, undefined, 'a rejected correction does not invalidate');
});

test('CORRECTIONS still work when compatible (the existing semantics are preserved)', async () => {
  const store = fakeStore();
  const c = svc(store, contractSkill(['postpartum_state', 'bleeding_duration_hours']), { corrections: [{ target: 'postpartum_state', new: 'لا' }], correctionsOnTurn: 3 });
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  await c.handleMessage('p', 'a', s.id, { text: 'نعم', answers: [{ key: 'postpartum_state', value: true }] });
  assert.equal(factOf(store, s.id, 'postpartum_state'), true);

  await c.handleMessage('p', 'a', s.id, { text: 'لا، قصدي لا' });
  assert.equal(factOf(store, s.id, 'postpartum_state'), false, 'a compatible correction supersedes');
  assert.ok(metaOf(store, s.id, 'postpartum_state')?.superseded, 'the old value is recorded as superseded');
});

// ---------------------------------------------------------------- §20 ------

test('SAME-VALUE REBINDING: an accepted re-answer of the same value is not a material change', async () => {
  const store = fakeStore();
  // Three needs, so the contract stays available while the case is still being completed.
  const c = svc(store, contractSkill(['postpartum_state', 'bleeding_duration_hours', 'habit_days']));
  const s = await c.create('p', 'a', 'private');
  await c.handleMessage('p', 'a', s.id, { text: 'حالة' });
  await c.handleMessage('p', 'a', s.id, { text: 'نعم', answers: [{ key: 'postpartum_state', value: true }] });
  await c.handleMessage('p', 'a', s.id, { text: '6', answers: [{ key: 'bleeding_duration_hours', value: 6 }] });

  // The very same value again — ACCEPTED against the known contract, but not a material change.
  const t4 = await c.handleMessage('p', 'a', s.id, { text: 'نعم', answers: [{ key: 'postpartum_state', value: true }] });
  assert.equal(factOf(store, s.id, 'postpartum_state'), true, 'the value is unchanged');
  assert.equal(metaOf(store, s.id, 'postpartum_state')?.certainty, 'CERTAIN');
  assert.equal(t4.caseState?.groundedResult, 'none', 'no spurious grounded/invalidated state');
  assert.equal(t4.caseState?.invalidationReason, undefined, 'a same-value rebind is not a material change');
  assert.equal(t4.status, 'needs_information', 'the case simply continues to its next need');
});
