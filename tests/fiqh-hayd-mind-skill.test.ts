/**
 * Naqaa Mind Skill V0 (experiment) — focused deterministic tests.
 *
 * These prove the SHELL: prompt fidelity (the user's own words must reach the model),
 * the ONE-question mapping onto the existing readiness adapter, fail-closed grounding,
 * citation rejection, and state safety (the model never writes trusted state).
 * The model's *judgement* is measured by the live A/B harness, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFiqhHaydMindSkill, MIND_SKILL_ID, MIND_SKILL_VERSION } from '../src/domain/naqaa/fiqh-hayd-mind-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';
import { createFiqhHaydSkill } from '../src/domain/naqaa/fiqh-hayd-skill.ts';

const APPROVED_ID = 'src-approved-1';
const CHUNK_A = 'chunk-a';
const CHUNK_B = 'chunk-b';
const skill = createFiqhHaydMindSkill({ readiness: new DecisionReadinessService() });

const passage = (chunkId: string): SkillKnowledgePassage => ({
  chunkId, documentId: 'doc-1', sourceId: APPROVED_ID, sourceTitle: APPROVED_SOURCE_TITLES[0],
  chunkIndex: 1, text: 'نص فقهي معتمد يوضح الشرط.', score: 0.5,
});

function knowledge(opts: { hits?: boolean; approved?: boolean } = {}) {
  const calls = { searches: 0, resolves: 0 };
  return {
    calls,
    async search() { calls.searches += 1; return opts.hits === false ? [] : [passage(CHUNK_A)]; },
    async resolveSources(titles: string[]) {
      calls.resolves += 1;
      return opts.approved === false || !titles.includes(APPROVED_SOURCE_TITLES[0]) ? [] : [{ id: APPROVED_ID, title: APPROVED_SOURCE_TITLES[0] }];
    },
    async adjacent() { return opts.hits === false ? [] : [passage(CHUNK_B)]; },
  };
}

function model(responses: string[]) {
  const calls: string[] = [];
  const perCall: Array<{ instructions?: string; message?: string }> = [];
  return {
    calls,
    perCall,
    async generateText(input: { instructions?: string; message?: string }) {
      perCall.push(input);
      calls.push([input.instructions, input.message].filter(Boolean).join('\n\n'));
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? '{}';
      return { text, model: 'scripted-model' };
    },
  };
}

async function run(opts: {
  text: string;
  responses: string[];
  context?: Record<string, unknown>;
  factMeta?: Record<string, { certainty?: string; provenance?: string }>;
  recentTurns?: Array<{ role: string; text: string }>;
  knowledgeOpts?: { hits?: boolean; approved?: boolean };
}) {
  const k = knowledge(opts.knowledgeOpts ?? {});
  const m = model(opts.responses);
  const ctx = {
    projectId: 'p', actor: 'a',
    input: {
      text: opts.text,
      context: opts.context ?? {},
      factMeta: opts.factMeta ?? {},
      recentTurns: opts.recentTurns ?? [],
    },
    knowledge: k, model: m,
  } as unknown as SkillExecutionContext;
  const out = (await skill.execute(ctx)) as Record<string, any>;
  return { out, k, m };
}

const needInfo = (question: string, key?: string) =>
  JSON.stringify({ status: 'NEED_INFO', question, key, reason: 'test' });
const needEvidence = (queries: string[], materialFactKeys = ['purity_seen']) =>
  JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: queries, materialFactKeys });
const answer = (text: string, refs: string[], materialFactKeys = ['purity_seen']) =>
  JSON.stringify({ status: 'ANSWER', message: text, evidenceRefs: refs, materialFactKeys });
const confirmedPurity = {
  context: { purity_seen: true },
  factMeta: { purity_seen: { certainty: 'CERTAIN', provenance: 'user_answer' } },
};

// ---------------------------------------------------------------------------
// Case A — explicit colour must be visible to the model and never re-asked by the shell
// ---------------------------------------------------------------------------
test('Mind V0/A: the user\'s OWN colour wording reaches the model, with the no-re-ask rule', async () => {
  const text = 'نزل علي سائل شفاف في آخر أيام الدورة مع لمعة حمراء خفيفة .. هل هذا حيض ؟';
  const { out, m } = await run({
    text,
    responses: [needInfo('هل ما زال هذا السائل ينزل حتى الآن؟', 'still_flowing')],
  });
  const prompt = m.calls[0];
  assert.ok(prompt.includes('سائل شفاف'), 'the model must receive the user\'s colour wording');
  assert.ok(prompt.includes('لمعة حمراء خفيفة'), 'the model must receive the full description');
  assert.ok(prompt.includes('لا تسأل عن معلومة ذكرها المستخدم صراحة'), 'the no-re-ask rule must be in the instruction');
  assert.ok(prompt.includes('سؤال واحد فقط في كل دور'), 'the ONE-question rule must be in the instruction');
  assert.ok(m.perCall[0].instructions?.includes('أنت «عقل نقاء»'), 'trusted rules must use the instruction channel');
  assert.equal(m.perCall[0].message?.includes('لا تسأل عن معلومة ذكرها المستخدم صراحة'), false, 'trusted rules must not be mixed into user content');
  // The shell asks exactly one question, chosen by the model.
  assert.equal(out.readiness.status, 'NEEDS_INFORMATION');
  assert.equal(out.readiness.missing.length, 1);
  assert.equal(out.readiness.missing[0].question.wording, 'هل ما زال هذا السائل ينزل حتى الآن؟');
  assert.equal(m.calls.length, 1, 'asking needs ONE model call');
});

// ---------------------------------------------------------------------------
// Case B — explicit duration / pregnancy / postpartum / cessation reach the model
// ---------------------------------------------------------------------------
test('Mind V0/B: explicit duration, pregnancy, postpartum and cessation all reach the model', async () => {
  const text = 'نزل علي دم اليوم، وأنا مو حامل ولا نفساء، واستمر 7 ساعات وبعدين وقف. هل أصلي؟';
  const { out, m } = await run({
    text,
    responses: [needInfo('هل هذا الدم نزل بعد ولادة أو في زمن الحيض المعتاد؟', 'timing_context')],
  });
  const prompt = m.calls[0];
  for (const fragment of ['7 ساعات', 'مو حامل', 'نفساء', 'وقف']) {
    assert.ok(prompt.includes(fragment), `the model must see the explicit fragment: ${fragment}`);
  }
  assert.equal(out.readiness.missing.length, 1, 'at most ONE question');
  assert.equal(out.readiness.missing[0].key, 'timing_context');
});

// ---------------------------------------------------------------------------
// Case C — thin information → NEED_INFO with exactly ONE question
// ---------------------------------------------------------------------------
test('Mind V0/C: thin information yields NEED_INFO with exactly one material question', async () => {
  const { out } = await run({ text: 'نزل مني شيء غريب، ما الحكم؟', responses: [needInfo('ما الذي نزل بالضبط، ومتى بدأ؟')] });
  assert.equal(out.readiness.status, 'NEEDS_INFORMATION');
  assert.equal(out.readiness.missing.length, 1);
  assert.equal(out.trace.status, 'NEED_INFO');
  assert.equal(out.answer, undefined, 'a question turn must not carry a ruling');
});

// ---------------------------------------------------------------------------
// Case D — no approved evidence → INSUFFICIENT_EVIDENCE, never a fabricated ruling
// ---------------------------------------------------------------------------
test('Mind V0/D: a source gap returns INSUFFICIENT_EVIDENCE with no ruling', async () => {
  const { out } = await run({
    text: 'نزل سائل أصفر بعد الطهر، هل أصلي؟',
    ...confirmedPurity,
    responses: [needEvidence(['الصفرة بعد الطهر عند الشافعية'])],
    knowledgeOpts: { hits: false },
  });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('no_approved_source_evidence_retrieved'));
  assert.equal(out.readiness, undefined, 'no question when the gap is evidential');
  assert.ok(typeof out.answer.text === 'string' && out.answer.text.length > 0, 'an honest notice, not a ruling');
  assert.equal(out.answer.evidenceIds, undefined, 'no evidence claimed');
  assert.equal(out.caseFacts, undefined, 'no state written');
});

test('Mind V0/D2: a missing approved source is a source gap, not a guess', async () => {
  const { out, m } = await run({ text: 'هل هذا حيض؟', responses: [needInfo('ما لون السائل؟')], knowledgeOpts: { approved: false } });
  assert.equal(m.calls.length, 0, 'no model call without an approved source');
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('approved_sources_missing'));
});

// ---------------------------------------------------------------------------
// Case E — citation hallucination is rejected (fail-closed)
// ---------------------------------------------------------------------------
test('Mind V0/E: a citation of an unretrieved chunk is rejected and no ruling is returned', async () => {
  const { out } = await run({
    text: 'نزل سائل شفاف في آخر الدورة، هل هو حيض؟',
    ...confirmedPurity,
    responses: [needEvidence(['لون الإفرازات في آخر الحيض']), answer('هذا حيض بالإجماع.', ['chunk-does-not-exist'])],
  });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('citation_rejected'));
  assert.equal(out.answer.evidenceIds, undefined);
  assert.deepEqual(out.trace.acceptedEvidenceRefs, undefined);
});

test('Mind V0/E2: a valid retrieved citation is accepted and recorded', async () => {
  const { out } = await run({
    text: 'نزل سائل شفاف في آخر الدورة، هل هو حيض؟',
    ...confirmedPurity,
    responses: [needEvidence(['لون الإفرازات في آخر الحيض']), answer('تفصيل الحكم كذا.', [CHUNK_B, 'bogus-id'])],
  });
  assert.equal(out.trace.status, 'ANSWER');
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_B], 'only the actually-retrieved chunk is accepted');
  assert.deepEqual(out.trace.acceptedEvidenceRefs, [CHUNK_B]);
  assert.equal(out.trace.sourceSupport, 'SUPPORTED');
});

// ---------------------------------------------------------------------------
// Case F — state safety: the model never writes trusted case state
// ---------------------------------------------------------------------------
test('Mind V0/F: the skill writes NO case state, so inference can never become a fact', async () => {
  const forAnswer = await run({
    text: 'نزل سائل شفاف، هل هو حيض؟',
    ...confirmedPurity,
    responses: [needEvidence(['وصف الإفرازات']), answer('الجواب.', [CHUNK_A])],
  });
  assert.equal(forAnswer.out.trace.status, 'ANSWER');
  const forQuestion = await run({ text: 'هل هذا حيض؟', responses: [needInfo('ما لون السائل؟')] });
  for (const r of [forAnswer, forQuestion]) {
    assert.equal(r.out.caseFacts, undefined, 'mobile model output must never become a case fact');
    assert.equal(r.out.skillContext, undefined, 'no B3a turn context is written');
  }
  // The explicit user facts ARE visible to the model with their certainty, so the model can
  // distinguish known from uncertain without any fact engine.
  const withFacts = await run({
    text: 'ما الحكم؟',
    responses: [needInfo('ما لون السائل؟')],
    context: { bleeding_duration_hours: 7, cycle_interval_days: 'UNKNOWN' },
    factMeta: { bleeding_duration_hours: { certainty: 'CERTAIN', provenance: 'user_statement' }, cycle_interval_days: { certainty: 'UNKNOWN', provenance: 'user_answer' } },
  });
  const p = withFacts.m.calls[0];
  assert.ok(p.includes('bleeding_duration_hours = 7 (CERTAIN, user_statement)'), 'certainty travels with the fact');
  assert.ok(p.includes('cycle_interval_days = UNKNOWN (UNKNOWN, user_answer)'), 'an UNKNOWN value is labelled as such');
});

test('admission round 5: Mind treats context without fact metadata as advisory', async () => {
  const { m } = await run({
    text: 'ما الحكم؟',
    context: { unverified_note: 'claimed value' },
    responses: [needInfo('ما المعلومة المؤكدة؟', 'confirmed_note')],
  });
  assert.ok(m.calls[0].includes('unverified_note = claimed value (UNCERTAIN, user_statement)'));
  assert.equal(m.calls[0].includes('(CERTAIN, user)'), false);
});

function mindConversation(responses: string[]) {
  const registry = new MapSkillRegistry();
  registry.register(skill);
  const m = model(responses);
  const runtime = new SkillsRuntime({
    persistence: {
      async getProject(id: string) { return { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' }; },
      async getMembership(projectId: string, actor: string) { return { projectId, actor, role: 'owner' as const, createdAt: '' }; },
      async createRun() {}, async updateRun() {},
    },
    registry,
    understanding: new UnderstandingService(),
    memory: { async fetchBounded() { return { user: [], conversation: [], case: [] }; } },
    knowledge: () => knowledge(),
    modelGateway: {
      async generateText({ instructions, input }) {
        const message = input && typeof input === 'object' && 'message' in input && typeof input.message === 'string'
          ? input.message
          : undefined;
        return m.generateText({ instructions, message });
      },
      async embedTexts() { throw new Error('unexpected embedding call'); },
    },
  });
  const rows = new Map<string, ConversationSession>();
  const conversation = new ConversationService({
    persistence: {
      async create(session) { rows.set(session.id, session); return session; },
      async get(projectId, actor, id) { const session = rows.get(id); return session?.projectId === projectId && session.actorSubject === actor ? session : null; },
      async save(session) { rows.set(session.id, session); return session; },
    },
    understanding: new UnderstandingService(),
    skills: { execute: (input) => runtime.execute(input) },
    defaultSkillId: MIND_SKILL_ID,
  });
  return { conversation, rows, m };
}

test('final transition: a stage-1 Mind refusal invalidates a supported control ruling across real Runtime skill switches', async () => {
  const control = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
  const registry = new MapSkillRegistry();
  registry.register(control);
  registry.register(skill);
  let controlCalls = 0;
  let mindCalls = 0;
  const controlReplies = [
    JSON.stringify({ issue: 'حكم مدة الدم', queries: ['أقل الحيض'] }),
    JSON.stringify({ interpretations: [], requirements: [], unresolved: [] }),
    JSON.stringify({
      status: 'DECIDED', category: 'ليس حيضًا', directAnswer: 'هذا ليس حيضًا.',
      explanation: 'لأن المدة أقل من الحد.', confidence: 'MEDIUM', sourceSupport: 'SUPPORTED',
      evidenceRefs: [CHUNK_A], materialFactKeys: ['bleeding_duration_hours'], observationMappings: [], unresolved: [],
    }),
    JSON.stringify({ issue: 'سبب الحكم السابق', queries: ['أقل الحيض'] }),
    JSON.stringify({ interpretations: [], requirements: [], unresolved: [] }),
    JSON.stringify({ status: 'SOURCE_GAP', unresolved: [{ item: 'لا توجد حالة قابلة للحسم', material: true }] }),
  ];
  const runtime = new SkillsRuntime({
    persistence: {
      async getProject(id: string) { return { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' }; },
      async getMembership(projectId: string, actor: string) { return { projectId, actor, role: 'owner' as const, createdAt: '' }; },
      async createRun() {}, async updateRun() {},
    },
    registry,
    understanding: new UnderstandingService(),
    memory: { async fetchBounded() { return { user: [], conversation: [], case: [] }; } },
    knowledge: () => knowledge(),
    modelGateway: {
      async generateText({ capability }) {
        if (capability === MIND_SKILL_ID) {
          mindCalls += 1;
          return { text: JSON.stringify({ status: 'INSUFFICIENT_EVIDENCE', message: 'النصوص لا تكفي.' }), model: 'scripted-model' };
        }
        return { text: controlReplies[controlCalls++] ?? '{}', model: 'scripted-model' };
      },
      async embedTexts() { throw new Error('unexpected embedding call'); },
    },
  });
  const rows = new Map<string, ConversationSession>();
  const conversation = new ConversationService({
    persistence: {
      async create(session) { rows.set(session.id, session); return session; },
      async get(projectId, actor, id) { const session = rows.get(id); return session?.projectId === projectId && session.actorSubject === actor ? session : null; },
      async save(session) { rows.set(session.id, session); return session; },
    },
    understanding: new UnderstandingService(),
    skills: { execute: (input) => runtime.execute(input) },
    defaultSkillId: control.id,
  });
  const session = await conversation.create('p', 'a', 'private');
  const state = rows.get(session.id)!.sessionContext;
  state.facts.bleeding_duration_hours = 6;
  state.factMeta = { bleeding_duration_hours: { certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z' } };

  const supported = await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟', skillId: control.id });
  assert.equal(supported.caseState?.groundedResult, 'valid');
  assert.ok(rows.get(session.id)!.sessionContext.lastGroundedResult);

  const refused = await conversation.handleMessage('p', 'a', session.id, { text: 'أعيدي التحقق.', skillId: MIND_SKILL_ID });
  assert.equal(mindCalls, 1, 'stage 1 refusal is terminal and performs no retrieval-stage model call');
  assert.equal(refused.trace?.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(refused.caseState?.groundedResult, 'invalidated');
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);

  const why = await conversation.handleMessage('p', 'a', session.id, { text: 'ليش؟', skillId: control.id });
  assert.ok(controlCalls > 3, 'control must reason again instead of replaying the old ruling');
  assert.notEqual(why.answer?.text, supported.answer?.text);
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
});

test('admission round 6: real Conversation and Runtime reject invented first-stage facts but accept confirmed context', async () => {
  const inventedOnset = 'بدأ الدم أمس';
  const proposed = JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'], knownFacts: [inventedOnset] });
  const confirmedProposal = JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'], materialFactKeys: ['onset'] });
  const personal = answer('هذا حيض شخصيًا.', [CHUNK_A], ['onset']);
  const { conversation, rows, m } = mindConversation([
    proposed,
    needInfo('متى بدأ الدم؟', 'onset'),
    proposed,
    confirmedProposal, personal,
  ]);
  const session = await conversation.create('p', 'a', 'private');
  const rejected = await conversation.handleMessage('p', 'a', session.id, { text: 'نزل الدم ولا أعرف متى بدأ. ما الحكم؟' });
  assert.equal(rejected.status, 'completed');
  assert.notEqual(rejected.message, 'هذا حيض شخصيًا.');
  assert.equal(rejected.trace?.decisionStatus, undefined);
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
  assert.equal(m.perCall.length, 1, 'an unverified first-stage fact cannot reach the evidence stage');

  const asked = await conversation.handleMessage('p', 'a', session.id, { text: 'ما المعلومة الناقصة؟' });
  assert.equal(asked.interaction?.type, 'free_text');
  assert.equal(asked.interaction?.key, 'onset');
  const raw = await conversation.handleMessage('p', 'a', session.id, { text: inventedOnset });
  assert.equal(raw.trace?.decisionStatus, undefined);
  assert.equal(rows.get(session.id)!.sessionContext.factMeta?.onset, undefined);

  const accepted = await conversation.handleMessage('p', 'a', session.id, {
    text: 'بدأ الدم صباح الأحد', answers: [{ key: 'onset', value: 'صباح الأحد' }],
  });
  assert.match(m.perCall[4].message ?? '', /حقائق مؤكدة من سياق الخادم \(المادية المختارة في المرحلة الأولى\):\n[^\n]*onset = صباح الأحد/);
  assert.equal(rows.get(session.id)!.sessionContext.factMeta?.onset?.provenance, 'user_answer');
  assert.equal(accepted.message, 'هذا حيض شخصيًا.');
  assert.equal(accepted.trace?.decisionStatus, 'ANSWER');
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult?.status, 'ANSWER');
});

const onsetProposal = JSON.stringify({
  status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'], knownFacts: ['onset = بدأ الدم أمس'], materialFactKeys: ['onset'],
});
const personalOnsetAnswer = (materialFactKeys: unknown) => JSON.stringify({
  status: 'ANSWER', message: 'بما أن الدم بدأ أمس، فهذا حيض.', evidenceRefs: [CHUNK_A], materialFactKeys,
});

test('Mind two-stage contract: stage 2 cannot hide an invented onset behind an unrelated confirmed preference', async () => {
  const { conversation, rows } = mindConversation([
    needInfo('بأي لغة تريدين الجواب؟', 'preferred_language'),
    JSON.stringify({
      status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'],
      knownFacts: ['onset = بدأ الدم أمس'],
    }),
    personalOnsetAnswer(['preferred_language']),
  ]);
  const session = await conversation.create('p', 'a', 'private');
  await conversation.handleMessage('p', 'a', session.id, { text: 'أحتاج مساعدة.' });
  const response = await conversation.handleMessage('p', 'a', session.id, {
    text: 'بالعربية، ولا أعرف متى بدأ الدم.',
    answers: [{ key: 'preferred_language', value: 'العربية' }],
  });
  assert.equal(response.message, 'الدليل المتاح غير كافٍ للإجابة.');
  assert.equal(response.trace?.decisionStatus, undefined);
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
});

test('Mind two-stage contract: presentation preferences are never material decision authority', async () => {
  const { conversation, rows, m } = mindConversation([
    needInfo('بأي لغة تريدين الجواب؟', 'preferred_language'),
    JSON.stringify({
      status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'], materialFactKeys: ['preferred_language'],
    }),
    personalOnsetAnswer(['preferred_language']),
  ]);
  const session = await conversation.create('p', 'a', 'private');
  await conversation.handleMessage('p', 'a', session.id, { text: 'أحتاج مساعدة.' });
  const response = await conversation.handleMessage('p', 'a', session.id, {
    text: 'بالعربية', answers: [{ key: 'preferred_language', value: 'العربية' }],
  });
  assert.equal(response.message, 'الدليل المتاح غير كافٍ للإجابة.');
  assert.equal(response.trace?.decisionStatus, undefined);
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
  assert.equal(m.perCall.length, 2, 'presentation-only facts stop before retrieval');
});

test('Mind two-stage contract: both stages must name the same admitted material facts', async () => {
  const { conversation, rows, m } = mindConversation([
    needInfo('متى بدأ الدم؟', 'onset'),
    JSON.stringify({
      status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'],
      knownFacts: ['onset = أمس'], materialFactKeys: ['onset'],
    }),
    personalOnsetAnswer(['onset']),
  ]);
  const session = await conversation.create('p', 'a', 'private');
  await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
  const response = await conversation.handleMessage('p', 'a', session.id, {
    text: 'بدأ أمس', answers: [{ key: 'onset', value: 'أمس' }],
  });
  assert.equal(response.trace?.decisionStatus, 'ANSWER');
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult?.status, 'ANSWER');
  assert.deepEqual(rows.get(session.id)!.sessionContext.lastGroundedResult?.materialFactKeys, ['onset']);
  assert.match(m.perCall[2].message ?? '', /onset = أمس/);
  assert.doesNotMatch(m.perCall[2].message ?? '', /مقترحات غير متحققة/);
});

test('Mind two-stage contract: duplicate stage-2 keys cannot impersonate a missing dependency', async () => {
  const { out } = await run({
    text: 'ما الحكم؟',
    context: { onset: 'أمس', duration_days: 6 },
    factMeta: {
      onset: { certainty: 'CERTAIN', provenance: 'user_answer' },
      duration_days: { certainty: 'CERTAIN', provenance: 'user_answer' },
    },
    responses: [
      needEvidence(['حكم البداية'], ['onset', 'duration_days']),
      personalOnsetAnswer(['onset', 'onset']),
    ],
  });
  assert.equal(out.trace?.decisionStatus, undefined);
  assert.equal(out.answer?.text, 'الدليل المتاح غير كافٍ للإجابة.');
});

test('Mind two-stage contract: reordered unique dependency sets remain equivalent', async () => {
  const { out } = await run({
    text: 'ما الحكم؟',
    context: { onset: 'أمس', duration_days: 6 },
    factMeta: {
      onset: { certainty: 'CERTAIN', provenance: 'user_answer' },
      duration_days: { certainty: 'CERTAIN', provenance: 'user_answer' },
    },
    responses: [
      needEvidence(['حكم البداية'], ['onset', 'duration_days']),
      JSON.stringify({
        status: 'ANSWER', message: 'حكم موثق.', evidenceRefs: [CHUNK_A],
        materialFactKeys: ['duration_days', 'onset'],
      }),
    ],
  });
  assert.equal(out.trace?.decisionStatus, 'ANSWER');
  assert.equal(out.answer?.text, 'حكم موثق.');
});

for (const key of [
  'preferred_language', 'preferredLanguage', 'language', 'locale',
  'output_language', 'outputLanguage', 'response_language', 'responseLanguage',
  'preferred_locale', 'preferredLocale', 'output_locale', 'response_locale',
]) {
  test(`Mind two-stage contract: presentation key ${key} cannot authorize a ruling`, async () => {
    const { out, m } = await run({
      text: 'ما الحكم؟',
      context: { [key]: 'Arabic' },
      factMeta: { [key]: { certainty: 'CERTAIN', provenance: 'user_answer' } },
      responses: [needEvidence(['حكم الحالة'], [key]), personalOnsetAnswer([key])],
    });
    assert.equal(out.trace?.decisionStatus, undefined);
    assert.equal(out.answer?.text, 'الدليل المتاح غير كافٍ للإجابة.');
    assert.equal(m.calls.length, 1, 'presentation-only authority stops before retrieval');
  });
}

for (const key of ['preferred_locale', 'preferredLocale', 'output_locale', 'response_locale']) {
  test(`Mind two-stage contract: private admitted presentation key ${key} cannot authorize a ruling`, async () => {
    const { conversation, rows, m } = mindConversation([
      needInfo('ما تفضيل العرض؟', key),
      needEvidence(['حكم الحالة'], [key]),
      personalOnsetAnswer([key]),
    ]);
    const session = await conversation.create('p', 'a', 'private');
    const first = await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
    assert.equal(first.interaction?.key, key);

    const response = await conversation.handleMessage('p', 'a', session.id, {
      text: 'العربية', answers: [{ key, value: 'العربية' }],
    });
    const context = rows.get(session.id)!.sessionContext;
    assert.equal(context.factMeta?.[key]?.certainty, 'CERTAIN');
    assert.equal(m.calls.length, 2, 'presentation-only authority stops before retrieval and stage 2');
    assert.equal(response.trace?.decisionStatus, undefined);
    assert.equal(context.lastGroundedResult, undefined);
  });
}

for (const key of ['output_style', 'responseStyle', 'preferred_format']) {
  test(`final fiqh fix round 1: private admitted presentation key ${key} cannot authorize Mind`, async () => {
    const { conversation, rows, m } = mindConversation([
      needInfo('ما تفضيل العرض؟', key),
      needEvidence(['حكم الحالة'], [key]),
      personalOnsetAnswer([key]),
    ]);
    const session = await conversation.create('p', 'a', 'private');
    await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
    const response = await conversation.handleMessage('p', 'a', session.id, {
      text: 'مختصر', answers: [{ key, value: 'مختصر' }],
    });
    const context = rows.get(session.id)!.sessionContext;
    assert.equal(context.factMeta?.[key]?.certainty, 'CERTAIN');
    assert.equal(m.calls.length, 2, 'presentation-only authority stops before retrieval and stage 2');
    assert.equal(response.trace?.decisionStatus, undefined);
    assert.equal(context.lastGroundedResult, undefined);
  });
}

test('Mind two-stage contract: a clinical key containing a generic presentation word is not rejected', async () => {
  const key = 'bleeding_language_observation';
  const { out } = await run({
    text: 'ما الحكم؟',
    context: { [key]: 'وصف مؤكد' },
    factMeta: { [key]: { certainty: 'CERTAIN', provenance: 'user_answer' } },
    responses: [needEvidence(['حكم الحالة'], [key]), personalOnsetAnswer([key])],
  });
  assert.equal(out.trace?.decisionStatus, 'ANSWER');
});

test('Mind two-stage contract: a clinical key containing locale is not rejected', async () => {
  const key = 'bleeding_locale_observation';
  const { out } = await run({
    text: 'ما الحكم؟',
    context: { [key]: 'وصف مؤكد' },
    factMeta: { [key]: { certainty: 'CERTAIN', provenance: 'user_answer' } },
    responses: [needEvidence(['حكم الحالة'], [key]), personalOnsetAnswer([key])],
  });
  assert.equal(out.trace?.decisionStatus, 'ANSWER');
});

test('admission round 7: unrelated admitted facts and invented onset cannot authorize an answer', async () => {
  const { conversation, rows, m } = mindConversation([
    needInfo('بأي لغة تريدين الجواب؟', 'preferred_language'),
    onsetProposal, personalOnsetAnswer(['preferred_language', 'onset']),
  ]);
  const session = await conversation.create('p', 'a', 'private');
  await conversation.handleMessage('p', 'a', session.id, { text: 'أحتاج مساعدة.' });
  const response = await conversation.handleMessage('p', 'a', session.id, {
    text: 'بالعربية. لا أعرف متى بدأ الدم. ما الحكم؟', answers: [{ key: 'preferred_language', value: 'العربية' }],
  });

  const context = rows.get(session.id)!.sessionContext;
  assert.equal(context.factMeta?.preferred_language?.certainty, 'CERTAIN');
  assert.equal(Object.hasOwn(context.facts, 'onset'), false);
  assert.equal(m.perCall.length, 2, 'unconfirmed first-stage dependencies stop before retrieval and stage 2');
  assert.equal(response.message, 'الدليل المتاح غير كافٍ للإجابة.');
  assert.equal(response.trace?.decisionStatus, undefined);
  assert.equal(response.answer?.evidenceIds, undefined);
  assert.equal(context.lastGroundedResult, undefined);
});

for (const { name, keys } of [
  { name: 'missing dependencies', keys: undefined },
  { name: 'empty dependencies', keys: [] },
  { name: 'a non-array dependency list', keys: 'onset' },
  { name: 'a malformed dependency among valid keys', keys: ['onset', 1] },
  { name: 'a padded dependency key', keys: ['onset '] },
  { name: 'a differently cased key', keys: ['Onset'] },
]) {
  test(`admission round 7: Mind rejects ${name} even with admitted onset`, async () => {
    const { conversation, rows } = mindConversation([
      needInfo('متى بدأ الدم؟', 'onset'), onsetProposal, personalOnsetAnswer(keys),
    ]);
    const session = await conversation.create('p', 'a', 'private');
    await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
    const response = await conversation.handleMessage('p', 'a', session.id, {
      text: 'بدأ أمس', answers: [{ key: 'onset', value: 'أمس' }],
    });
    assert.equal(rows.get(session.id)!.sessionContext.factMeta?.onset?.certainty, 'CERTAIN');
    assert.equal(response.message, 'الدليل المتاح غير كافٍ للإجابة.');
    assert.equal(response.trace?.decisionStatus, undefined);
    assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
  });
}

test('admission round 7: invalid onset certainty cannot satisfy a named dependency', async () => {
  const { conversation, rows } = mindConversation([
    needInfo('بأي لغة تريدين الجواب؟', 'preferred_language'),
    needInfo('متى بدأ الدم؟', 'onset'),
    onsetProposal, personalOnsetAnswer(['onset']),
  ]);
  const session = await conversation.create('p', 'a', 'private');
  await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
  await conversation.handleMessage('p', 'a', session.id, {
    text: 'بالعربية', answers: [{ key: 'preferred_language', value: 'العربية' }],
  });
  const response = await conversation.handleMessage('p', 'a', session.id, {
    text: 'غير متأكدة', answers: [{ key: 'onset', value: 'غير متأكدة' }],
  });
  assert.equal(rows.get(session.id)!.sessionContext.factMeta?.onset?.certainty, 'UNKNOWN');
  assert.equal(response.message, 'الدليل المتاح غير كافٍ للإجابة.');
  assert.equal(response.trace?.decisionStatus, undefined);
  assert.equal(rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
});

test('admission round 7: distinct long onset keys survive both Mind stages and authorize a cited answer', async () => {
  const prefix = 'Bleeding_Onset_Recorded_For_Case';
  assert.equal(prefix.length, 32);
  const currentKey = `${prefix}_current`;
  const previousKey = `${prefix}_previous`.padEnd(64, '_');
  const { conversation, rows } = mindConversation([
    needInfo('متى بدأ الدم هذه المرة؟', currentKey),
    JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'], materialFactKeys: [currentKey] }),
    needInfo('متى بدأ الدم في المرة السابقة؟', previousKey),
    JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: ['حكم البداية'], materialFactKeys: [currentKey, previousKey] }),
    personalOnsetAnswer([currentKey, previousKey]),
  ]);
  const session = await conversation.create('p', 'a', 'private');
  const first = await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
  assert.equal(first.interaction?.key, currentKey);
  const second = await conversation.handleMessage('p', 'a', session.id, {
    text: 'بدأ أمس', answers: [{ key: first.interaction!.key, value: 'أمس' }],
  });
  assert.equal(second.interaction?.key, previousKey);
  const response = await conversation.handleMessage('p', 'a', session.id, {
    text: 'المرة السابقة كانت منذ شهر', answers: [{ key: second.interaction!.key, value: 'منذ شهر' }],
  });

  const context = rows.get(session.id)!.sessionContext;
  assert.deepEqual(context.facts, { [currentKey]: 'أمس', [previousKey]: 'منذ شهر' });
  assert.equal(context.factMeta?.[currentKey]?.certainty, 'CERTAIN');
  assert.equal(context.factMeta?.[previousKey]?.certainty, 'CERTAIN');
  assert.equal(response.trace?.decisionStatus, 'ANSWER');
  assert.deepEqual(response.answer?.evidenceIds, [CHUNK_A]);
  assert.equal(context.lastGroundedResult?.status, 'ANSWER');
});

for (const key of ['', 'Onset-Date', 'onset\n', '1onset', 'mind_followup', 'constructor', 'x'.repeat(65)]) {
  test(`admission round 7: invalid question key ${JSON.stringify(key)} never creates a binding control`, async () => {
    const { conversation, rows, m } = mindConversation([needInfo('متى بدأ الدم؟', key)]);
    const session = await conversation.create('p', 'a', 'private');
    const response = await conversation.handleMessage('p', 'a', session.id, { text: 'ما الحكم؟' });
    assert.equal(m.calls.length, 1, 'the invalid key must reach and fail the Mind parser');
    assert.equal(response.interaction, undefined);
    assert.equal(rows.get(session.id)!.sessionContext.pendingInteractionTrust, undefined);
  });

  test(`admission round 7: invalid evidence-stage question key ${JSON.stringify(key)} fails parsing`, async () => {
    const { out, m } = await run({
      text: 'ما الحكم؟',
      ...confirmedPurity,
      responses: [needEvidence(['حكم الحالة']), needInfo('متى بدأ الدم؟', key)],
    });
    assert.equal(m.calls.length, 2, 'the invalid key must reach and fail the evidence-stage parser');
    assert.equal(out.readiness, undefined);
    assert.equal(out.trace?.decisionStatus, undefined);
  });
}

for (const status of ['INSUFFICIENT_EVIDENCE', 'NEED_EVIDENCE', 'ERROR']) {
  test(`admission round 6: Mind does not publish a personal verdict from the ${status} gap`, async () => {
    const { out } = await run({
      text: 'متى بدأ الدم؟ لا أعرف. ما الحكم؟',
      ...confirmedPurity,
      responses: [needEvidence(['حكم البداية']), JSON.stringify({ status, message: 'أنت في الحيض الآن.', evidenceRefs: [CHUNK_A] })],
    });
    assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
    assert.notEqual(out.answer.text, 'أنت في الحيض الآن.');
    assert.equal(out.answer.evidenceIds, undefined);
    assert.equal(out.trace.decisionStatus, undefined);
  });
}

// ---------------------------------------------------------------------------
// Fail-closed plumbing
// ---------------------------------------------------------------------------
test('Mind V0: unreadable model output fails closed (no ruling, no question invented)', async () => {
  const { out } = await run({ text: 'هل هذا حيض؟', responses: ['not json at all'] });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(out.readiness, undefined);
  assert.equal(out.answer.evidenceIds, undefined);
});

// ---------------------------------------------------------------------------
// V0.1 — conversation quality (instruction-level, semantic assertions only)
// ---------------------------------------------------------------------------

// Test A — one question targets ONE fact (no compound question)
test('Mind V0.1/A: the one-question rule forbids combining two independent facts', async () => {
  const { m, out } = await run({ text: 'صار عندي انقطاع في الدورة ٣ أيام وبعدها نزل شي أصفر؟', responses: [needInfo('خلال الأيام الثلاثة اللي وقف فيها الدم، شفتي علامة الطهر؟', 'purity_sign')] });
  const prompt = m.calls[0];
  assert.ok(prompt.includes('سؤال واحد = معلومة واحدة'), 'the one-target rule must be in the instruction');
  assert.ok(prompt.includes('لا تجمع معلومتين'), 'combining two facts in one question must be forbidden explicitly');
  assert.ok(prompt.includes('يصبح ملتبسًا'), 'the reason (an ambiguous «نعم») must be stated');
  // Behaviour: exactly one information target reaches the readiness adapter.
  assert.equal(out.readiness.missing.length, 1);
  assert.equal(out.readiness.missing[0].key, 'purity_sign');
});

// Test B — every question must earn its place
test('Mind V0.1/B: the materiality principle is instructed before ASKING', async () => {
  const { m } = await run({ text: 'نزل سائل أصفر في اليوم التاسع، هل هذا حيض؟', responses: [needInfo('هل نزل قبلها علامة طهر؟', 'purity')] });
  const prompt = m.calls[0];
  assert.ok(prompt.includes('افهم أكثر، واسأل أقل'), 'the governing principle must be stated');
  assert.ok(prompt.includes('كل سؤال يجب أن يستحق مكانه'), 'each question must earn its place');
  assert.ok(prompt.includes('لن يغيّر شيئًا'), 'the "nothing changes → do not ask" rule must be stated');
  assert.ok(prompt.includes('ما المعلومة الناقصة بالضبط'), 'the internal question→consequence reasoning must be instructed');
  assert.ok(prompt.includes('ولا تُظهر هذا التفكير للمستخدم'), 'the internal reasoning must stay internal (§5)');
});

// Test B2 — the shell never invents a question; it asks only when the model decides to
test('Mind V0.1/B2: no question is produced when the model is ready to answer', async () => {
  const { out } = await run({
    text: 'نزل سائل أصفر في اليوم التاسع بعد طهر، هل هذا حيض؟',
    ...confirmedPurity,
    responses: [needEvidence(['الصفرة بعد الطهر']), answer('بما أن الصفرة نزلت بعد الطهر فهي ليست حيضًا. الحالة: طاهرة. تفعلين: لا شيء عليك. الدليل: النص المعتمد.', [CHUNK_A])],
  });
  assert.equal(out.readiness, undefined, 'an ANSWER turn must not carry a question');
  assert.equal(out.trace.status, 'ANSWER');
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A]);
});

// Test C — clearly supplied information is not asked again
test('Mind V0.1/C: supplied facts reach the model and are not re-questioned', async () => {
  const { m, out } = await run({
    text: 'دورتي في الغالب ٧ أيام ولكن الأصفر نزل في اليوم التاسع',
    context: { habit_days: 7, current_day: 9 },
    factMeta: { habit_days: { certainty: 'CERTAIN', provenance: 'user_statement' } },
    responses: [needEvidence(['حكم الصفرة'])],
  });
  const prompt = m.calls[0];
  assert.ok(prompt.includes('دورتي في الغالب ٧ أيام'), 'the user wording must be present');
  assert.ok(prompt.includes('habit_days = 7 (CERTAIN, user_statement)'), 'the known fact and its certainty must be present');
  assert.ok(prompt.includes('لا تسأل عن معلومة ذكرها المستخدم صراحة'), 'the no-re-ask rule must be present');
  assert.ok(!out.readiness || out.readiness.missing.length === 1, 'never more than one question');
});

// Test C2 — the Mind sees its OWN previous questions, so a short answer keeps its referent
test('Mind V0.1/C2: previous questions travel with the answers (a short answer stays meaningful)', async () => {
  const { m } = await run({
    text: 'اي',
    recentTurns: [
      { role: 'user', text: 'صار عندي انقطاع في الدورة ٣ أيام وبعدها نزل شي أصفر؟' },
      { role: 'assistant', text: 'في الأيام الثلاثة التي انقطع فيها الدم، هل ظهرت علامة الطهر (جفاف تام أو سائل أبيض)؟' },
    ],
    responses: [needEvidence(['الصفرة بعد الطهر'])],
  });
  const prompt = m.calls[0];
  assert.ok(prompt.includes('أنت سألت'), 'the Mind\'s own questions must be present in the case context');
  assert.ok(prompt.includes('هل ظهرت علامة الطهر'), 'the exact question must be visible to the model');
  assert.ok(prompt.includes('المستخدمة: اي'), 'the short answer must be visible');
  assert.ok(!prompt.includes('SKILL_INVALID'), 'no shell-level templating error');
});

// Test D — accepted facts are expressed as known context, not as hypotheticals
test('Mind V0.1/D: the instruction prefers «بما أن» over re-opening a known fact with «إذا كان»', async () => {
  const { m } = await run({ text: 'الأصفر نزل في اليوم التاسع من دورتي المعتادة', responses: [needInfo('هل نزل بعد طهر؟')] });
  const prompt = m.calls[0];
  assert.ok(prompt.includes('بما أن'), 'the «بما أن» form must be instructed');
  assert.ok(prompt.includes('إذا كان'), 'the «إذا كان» form must be explicitly discouraged for accepted facts');
  assert.ok(prompt.includes('لا تُعِد فتح ما ذكره المستخدم'), 'the retention rule must be stated');
});

// Test E — answer hierarchy / action first, delivered in BOTH stages
test('Mind V0.1/E: the answer hierarchy (state, then action, then reason, then evidence) is instructed for the ANSWER stage', async () => {
  const { m } = await run({
    text: 'نزل سائل أصفر بعد الطهر، هل أصلي؟',
    ...confirmedPurity,
    responses: [needEvidence(['الصفرة بعد الطهر عند الشافعية']), answer('الحالة: طاهرة. تفعلين: صلاتك صحيحة. السبب: الصفرة بعد الطهر ليست حيضًا. الدليل: النص.', [CHUNK_A])],
  });
  const answerStagePrompt = m.calls[1];
  assert.ok(answerStagePrompt, 'the ANSWER stage must call the model');
  for (const fragment of ['حالتك الآن', 'ماذا تفعلين الآن', 'السبب باختصار', 'تنبيه واحد فقط', 'الدليل/المصدر']) {
    assert.ok(answerStagePrompt.includes(fragment), `the hierarchy element must be instructed: ${fragment}`);
  }
  assert.ok(answerStagePrompt.includes('ابدأ بالحالة والفعل'), 'leading with state + action must be instructed');
  assert.ok(answerStagePrompt.includes('لا تبدأ بسلسلة شروط'), 'a long conditional chain as an opening must be forbidden');
});

// Test F — plain, everyday language for an ordinary user
test('Mind V0.1/F: everyday Arabic with short sentences is instructed', async () => {
  const { m } = await run({ text: 'هل هذا حيض؟', responses: [needInfo('ما لون السائل؟')] });
  const prompt = m.calls[0];
  assert.ok(prompt.includes('بلغة يومية'), 'everyday language must be instructed');
  assert.ok(prompt.includes('جمل قصيرة'), 'short sentences must be instructed');
  assert.ok(prompt.includes('لمن لا يقرأ كتب الفقه'), 'the reader must be named as an ordinary user');
  assert.ok(prompt.includes('دون إخلال بدقة الحكم'), 'precision must be protected');
});

// Test G — grounding is preserved by the V0.1 instructions
test('Mind V0.1/G: V0.1 keeps the grounding rules and rejects any citation not actually retrieved', async () => {
  const ask = await run({ text: 'هل هذا حيض؟', responses: [needInfo('ما صفة السائل؟')] });
  const prompt = ask.m.calls[0];
  assert.ok(prompt.includes('لا تُفتِ من معرفتك العامة'), 'no fatwa from general knowledge');
  assert.ok(prompt.includes('لا تستشهد بمقطع لم يُعرض عليك'), 'no citation outside the shown passages');
  assert.ok(prompt.includes('النصوص المعتمدة'), 'approved sources remain the only evidence');

  const fabricated = await run({
    text: 'نزل سائل أصفر بعد الطهر، ما الحكم؟',
    ...confirmedPurity,
    responses: [needEvidence(['الصفرة بعد الطهر']), answer('هذا مباح بلا شك.', ['chunk-invented'])],
  });
  assert.equal(fabricated.out.trace.status, 'INSUFFICIENT_EVIDENCE', 'a fabricated citation can never become a ruling');
  assert.ok(fabricated.out.trace.notes.includes('citation_rejected'));
  assert.equal(fabricated.out.answer.evidenceIds, undefined);

  const accepted = await run({
    text: 'نزل سائل أصفر بعد الطهر، ما الحكم؟',
    ...confirmedPurity,
    responses: [needEvidence(['الصفرة بعد الطهر']), answer('بما أن الطهر ثبت فالصفرة ليست حيضًا.', [CHUNK_A, 'chunk-invented'])],
  });
  assert.deepEqual(accepted.out.answer.evidenceIds, [CHUNK_A], 'accepted ⊆ retrieved');
  assert.equal(accepted.out.trace.sourceSupport, 'SUPPORTED');
});

test('Mind V0.1: the version identifies the iteration', () => {
  assert.equal(MIND_SKILL_VERSION, 3);
  assert.equal(skill.version, 3);
});

// ---------------------------------------------------------------------------
// P0.1 — compact Understand → Retrieve → Decide handoff
// ---------------------------------------------------------------------------

const needEvidenceHandoff = (queries: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ status: 'NEED_EVIDENCE', searchQueries: queries, materialFactKeys: ['purity_seen'], ...extra });

// Test A — NEED_EVIDENCE produces a compact handoff that Call #2 actually receives
test('Mind P0.1/A: Call #1 hands Call #2 a compact understood-case handoff', async () => {
  const { m } = await run({
    text: '9',
    ...confirmedPurity,
    recentTurns: [
      { role: 'user', text: 'صار عندي انقطاع في الدورة ٣ أيام وبعدها نزل شي أصفر؟' },
      { role: 'assistant', text: 'هل نزل الأصفر بعد انتهاء أيام حيضك المعتادة؟' },
    ],
    responses: [
      needEvidenceHandoff(['حكم الصفرة بعد الطهر عند الشافعية'], {
        understanding: 'صفرة نزلت في اليوم التاسع بعد انقطاع دم ٣ أيام، وعادتها ٧ أيام.',
        knownFacts: ['نزل الأصفر بعد انتهاء أيام الحيض المعتادة', 'جف المكان تمامًا في أيام الانقطاع', 'مجموع الأيام من أول الدم إلى الأصفر ٩'],
        evidenceNeeded: ['هل الصفرة بعد الطهر حيض أم لا', 'ما علامة الطهر المعتبرة'],
      }),
      answer('بما أن الطهر ثبت فالصفرة ليست حيضًا.', [CHUNK_A]),
    ],
  });
  const answerPrompt = m.calls[1];
  assert.ok(answerPrompt, 'the evidence stage must call the model');
  assert.ok(answerPrompt.includes('صفرة نزلت في اليوم التاسع'), 'the understood issue must reach Call #2');
  assert.ok(!answerPrompt.includes('مقترحات غير متحققة من النموذج الأول'), 'model-authored facts must not cross the handoff as case facts');
  assert.ok(!answerPrompt.includes('مجموع الأيام من أول الدم إلى الأصفر ٩'), 'unverified proposals stay out of Call #2');
  assert.ok(answerPrompt.includes('هل الصفرة بعد الطهر حيض أم لا'), 'what the evidence must establish must reach Call #2');
  assert.ok(answerPrompt.includes('خلاصة فهم الحالة'), 'the handoff must be clearly labelled');
});

// Test B — Call #2 does NOT reconstruct the full conversation / case block
test('Mind P0.1/B: Call #2 receives the compact handoff instead of the full case block', async () => {
  const { m, out } = await run({
    text: '9',
    ...confirmedPurity,
    recentTurns: [
      { role: 'user', text: 'صار عندي انقطاع في الدورة ٣ أيام وبعدها نزل شي أصفر؟' },
      { role: 'assistant', text: 'هل نزل الأصفر بعد انتهاء أيام حيضك المعتادة؟' },
      { role: 'user', text: 'بعدها' },
    ],
    responses: [
      needEvidenceHandoff(['حكم الصفرة'], { understanding: 'صفرة بعد انتهاء العادة.', knownFacts: ['انقطع الدم ٣ أيام'] }),
      answer('الحالة: طاهرة. تفعلين: صلاتك صحيحة. الدليل: الحيض الالوكة.', [CHUNK_A]),
    ],
  });
  const firstPrompt = m.calls[0];
  const answerPrompt = m.calls[1];
  // Call #1 still gets the full role-labelled case (conversation quality is unchanged)…
  assert.ok(firstPrompt.includes('أنت سألت'), 'Call #1 keeps the full conversation transcript');
  assert.ok(firstPrompt.includes('المستخدمة:'), 'Call #1 keeps the user turns');
  // …Call #2 does not: no transcript, no case block, only the handoff + the evidence.
  assert.ok(!answerPrompt.includes('أنت سألت'), 'Call #2 must not receive the conversation transcript');
  assert.ok(!answerPrompt.includes('المستخدمة: صار عندي'), 'Call #2 must not receive the raw user turns');
  assert.ok(!answerPrompt.includes('سياق الحوار'), 'Call #2 must not receive the case block header');
  assert.ok(answerPrompt.includes('خلاصة فهم الحالة'), 'Call #2 receives the handoff');
  assert.ok(answerPrompt.includes('النصوص المعتمدة'), 'Call #2 receives the approved passages');
  assert.ok(answerPrompt.includes('[chunk-a]'), 'Call #2 receives the evidence identifiers');
  assert.equal(out.trace.status, 'ANSWER');
  // The trace proves the handoff was used.
  assert.ok(out.trace.notes.includes('handoff_facts=1'), `expected handoff counters, got ${JSON.stringify(out.trace.notes)}`);
  assert.ok(out.trace.notes.includes('handoff_proposals=0'));
  assert.ok(out.trace.notes.includes('handoff_needed=0'));
});

// Test C — all three evidence-stage statuses remain reachable
test('Mind P0.1/C: Call #2 can answer with confirmed facts, ask a question, or report a gap', async () => {
  const handoff = needEvidenceHandoff(['حكم الصفرة'], { understanding: 'صفرة بعد العادة.', knownFacts: ['انقطع الدم ٣ أيام'] });

  const answered = await run({ text: '9', ...confirmedPurity, responses: [handoff, answer('الحالة: طاهرة. تفعلين: صلاتك صحيحة. الدليل: النص.', [CHUNK_A])] });
  assert.equal(answered.out.trace.status, 'ANSWER');
  assert.equal(answered.out.readiness, undefined);

  const declined = await run({ text: '9', ...confirmedPurity, responses: [handoff, JSON.stringify({ status: 'INSUFFICIENT_EVIDENCE', message: 'النصوص المعروضة لا تكفي.' })] });
  assert.equal(declined.out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(declined.out.trace.notes.includes('mind_reported_insufficient_evidence'), 'the model may still decline on the evidence');
  assert.equal(declined.out.answer.evidenceIds, undefined);

  const asked = await run({ text: '9', ...confirmedPurity, responses: [handoff, needInfo('هل نزل الأصفر بعد انتهاء العادة أم قبلها؟', 'timing')] });
  assert.equal(asked.out.trace.status, 'NEED_INFO');
  assert.equal(asked.out.readiness.missing.length, 1, 'one question, one information target');
  assert.equal(asked.out.readiness.missing[0].question.wording, 'هل نزل الأصفر بعد انتهاء العادة أم قبلها؟');
});

// Test D — citation safety is untouched by the handoff
test('Mind P0.1/D: accepted refs remain a subset of the retrieved refs', async () => {
  const handoff = needEvidenceHandoff(['حكم الصفرة'], { understanding: 'صفرة بعد العادة.' });
  const fabricated = await run({ text: '9', ...confirmedPurity, responses: [handoff, answer('حكم بلا سند.', ['chunk-invented'])] });
  assert.equal(fabricated.out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(fabricated.out.trace.notes.includes('citation_rejected'));
  const mixed = await run({ text: '9', ...confirmedPurity, responses: [handoff, answer('بما أن الطهر ثبت فالصفرة ليست حيضًا.', [CHUNK_B, 'chunk-invented'])] });
  assert.deepEqual(mixed.out.answer.evidenceIds, [CHUNK_B], 'accepted ⊆ retrieved');
  assert.equal(mixed.out.trace.sourceSupport, 'SUPPORTED');
});

// Test F — a handoff cannot rescue unreadable output: the answer stage still fails closed
test('Mind P0.1/F: unreadable Call #2 output still fails closed', async () => {
  const { out } = await run({
    text: '9',
    ...confirmedPurity,
    responses: [needEvidenceHandoff(['حكم الصفرة'], { understanding: 'صفرة بعد العادة.', knownFacts: ['انقطع الدم ٣ أيام'] }), 'prose without any json object'],
  });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('unreadable_model_output'));
  assert.equal(out.readiness, undefined);
  assert.equal(out.answer.evidenceIds, undefined);
  assert.match(String(out.answer.text), /تعذّر ترتيب الجواب/);
});

test('Mind V0: identity and a NEAR-empty contract surface', () => {
  assert.equal(skill.id, MIND_SKILL_ID);
  assert.equal(skill.version, MIND_SKILL_VERSION);
  assert.equal(skill.readiness, undefined, 'no static readiness requirements: the skill reasons about its own need');
  assert.deepEqual(skill.requirements, { understanding: true, memory: true, knowledge: true, model: true });
  assert.equal(Object.keys(skill).filter((k) => typeof (skill as unknown as Record<string, unknown>)[k] === 'function').length, 3, 'only validateInput/validateOutput/execute');
});
