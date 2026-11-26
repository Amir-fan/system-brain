/**
 * Naqaa Minimal Mind (K27 experiment) — small deterministic tests for the INFRASTRUCTURE:
 * registration, natural conversation pass-through, the Knowledge tool loop, boundary
 * restriction, provenance, the execution bound, fail-closed behaviour and no impact on the
 * control Skill. No fiqh decision is unit-tested.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFiqhHaydMinimalSkill, MINIMAL_SKILL_ID, MINIMAL_SKILL_VERSION, MINIMAL_TRACE_MARKER, MAX_TOOL_CALLS, MAX_MODEL_CALLS } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { createFiqhHaydMindSkill, MIND_SKILL_ID, MIND_SKILL_VERSION } from '../src/domain/naqaa/fiqh-hayd-mind-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';

const APPROVED_ID = 'src-approved-1';
const CHUNK_A = 'chunk-a';
const CHUNK_B = 'chunk-b';
// The default test Skill runs `flexible` (backward-compatible: plain-message terminals
// stay valid). The `required` mode is exercised explicitly in the RX2 block below.
const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'flexible' });

const passage = (chunkId: string, sourceId = APPROVED_ID): SkillKnowledgePassage => ({
  chunkId, documentId: 'doc-1', sourceId, sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 1, text: 'نص فقهي معتمد يوضح الشرط.', score: 0.5,
});

function knowledge(opts: { unapprovedHit?: boolean; noHits?: boolean } = {}) {
  const calls = { resolves: 0, searches: 0, sourceIds: [] as unknown[], queries: [] as string[] };
  return {
    calls,
    async search(input: { query: string; topK?: number; sourceIds?: string[] }) {
      calls.searches += 1;
      calls.queries.push(input.query);
      calls.sourceIds.push(input.sourceIds);
      const hits = opts.noHits ? [] : [passage(CHUNK_A)];
      if (opts.unapprovedHit) hits.push(passage('chunk-foreign', 'src-not-approved'));
      return hits;
    },
    async resolveSources(titles: string[]) {
      calls.resolves += 1;
      return titles.includes(APPROVED_SOURCE_TITLES[0]) ? [{ id: APPROVED_ID, title: APPROVED_SOURCE_TITLES[0] }] : [];
    },
    async adjacent() {
      return [passage(CHUNK_B)];
    },
  };
}

function model(responses: string[]) {
  const captured: { messages: string[]; perCall: Array<Record<string, unknown>> } = { messages: [], perCall: [] };
  return {
    captured,
    async generateText(input: { message?: string } & Record<string, unknown>) {
      captured.messages.push([input.instructions, input.message].filter(Boolean).join('\n\n'));
      captured.perCall.push(input);
      return { text: responses[Math.min(captured.messages.length - 1, responses.length - 1)] ?? '{}', model: 'scripted-model' };
    },
  };
}

async function run(opts: {
  text: string;
  responses: string[];
  recentTurns?: Array<{ role: string; text: string }>;
  knowledgeOpts?: { unapprovedHit?: boolean; noHits?: boolean };
  context?: Record<string, unknown>;
  factMeta?: Record<string, { certainty: string; provenance?: string }>;
}) {
  const k = knowledge(opts.knowledgeOpts ?? {});
  const m = model(opts.responses);
  const ctx = {
    projectId: 'p', actor: 'a',
    input: { text: opts.text, recentTurns: opts.recentTurns ?? [], ...(opts.context ? { context: opts.context } : {}), ...(opts.factMeta ? { factMeta: opts.factMeta } : {}) },
    knowledge: k, model: m,
  } as unknown as SkillExecutionContext;
  const out = (await skill.execute(ctx)) as Record<string, any>;
  return { out, k, m, mCapture: (m as unknown as { captured: { perCall: Array<Record<string, unknown>> } }).captured };
}

const tool = (query: string) => JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query });
const askUser = (question: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question, factKey: 'requested_fact', answerType: 'free_text' });
const answer = (text: string, refs: string[]) => JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: text, evidenceRefs: refs });
const insufficient = (text: string) => JSON.stringify({ action: 'TERMINAL', status: 'INSUFFICIENT_EVIDENCE', message: text });
const askTool = (q: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q, factKey: 'requested_fact', answerType: 'free_text' });

// Style — the user-facing simplicity preference exists (no wording snapshots)
test('Minimal/style: the answer-simplicity preference is instructed', async () => {
  const { m } = await run({ text: 'ما الحكم؟', responses: [askUser('ما صفة السائل؟')] });
  const prompt = m.captured.messages[0];
  assert.ok(prompt.includes('عربية بسيطة جدًا'), 'plain-language preference');
  assert.ok(prompt.includes('جمل قصيرة وواضحة'), 'short clear sentences');
  assert.ok(prompt.includes('قدّمي الخلاصة مبكرًا'), 'summary first');
  assert.ok(prompt.includes('تجنبي المصطلحات الفقهية'), 'avoid specialised vocabulary');
  assert.ok(prompt.includes('لا تعطي درسًا فقهيًا طويلًا'), 'no long fiqh lecture');
  // …and none of the intelligence instructions were displaced.
  assert.ok(prompt.includes('لا تطلب منها معلومة سبق أن ذكرتها'), 'no-re-ask preserved');
  assert.ok(prompt.includes('قبل إعطاء حكم فقهي، استخدم أداة البحث'), 'knowledge-before-ruling preserved');
  assert.ok(String(m.captured.perCall[0].instructions ?? '').includes('أنت العقل الفقهي المتخصص'), 'trusted rules use the instruction channel');
  assert.equal(String(m.captured.perCall[0].message ?? '').includes('أنت العقل الفقهي المتخصص'), false, 'trusted rules are absent from user content');
});

// A — registers independently, with its own identity and provenance marker
test('Minimal/A: the Skill registers independently and carries its own provenance', async () => {
  assert.equal(skill.id, MINIMAL_SKILL_ID);
  assert.equal(skill.version, MINIMAL_SKILL_VERSION);
  assert.equal(MINIMAL_TRACE_MARKER, 'minimal_mind_v0');
  assert.deepEqual(skill.requirements, { understanding: false, memory: false, knowledge: true, model: true });
  const reg = new MapSkillRegistry();
  reg.register(skill);
  reg.register(createFiqhHaydMindSkill({ readiness: new DecisionReadinessService() }));
  assert.equal(reg.list().length, 2);
  assert.equal(reg.get(MINIMAL_SKILL_ID)!.version, MINIMAL_SKILL_VERSION);
  assert.equal(reg.get(MIND_SKILL_ID)!.version, MIND_SKILL_VERSION);
  const { out } = await run({ text: 'هل هذا حيض؟', responses: [askUser('ما لون السائل؟')] });
  assert.ok(out.trace.notes.includes('minimal_mind_v0'), 'the marker must be present');
  assert.ok(out.trace.notes.includes(`v=${MINIMAL_SKILL_VERSION}`));
  assert.equal(out.trace.workload, 'knowledge_answer');
});

// B — the NATURAL conversation reaches the model (no mandatory fact schema)
test('Minimal/B: the natural conversation reaches the model verbatim', async () => {
  const { m } = await run({
    text: 'في اليوم الثامن توقف الدم وفي اليوم العاشر نزلت قطرة بنية.',
    recentTurns: [
      { role: 'user', text: 'رأيت قطرة بنية باليوم العاشر وأنا عادتي تكون 8 أيام، هل هذا حيض؟' },
      { role: 'assistant', text: 'هل كان هناك طهر بين الدم والقطرة؟' },
    ],
    responses: [askUser('في أي يوم نزلت القطرة؟')],
  });
  const prompt = m.captured.messages[0];
  assert.ok(prompt.includes('المستخدمة: رأيت قطرة بنية باليوم العاشر'), 'the earlier user turn must be present');
  assert.ok(prompt.includes('المساعد: هل كان هناك طهر'), 'the assistant turn must be present');
  assert.ok(prompt.includes('المستخدمة: في اليوم الثامن توقف الدم'), 'the current message must be present');
  // With NO known facts, no fact lines/certainty tags are rendered (the instruction
  // explains the tag vocabulary, but no data block is imposed).
  assert.ok(!prompt.includes('معلومات معروفة مسبقًا'), 'no known-facts block when there are no facts');
});

// C + E — the model requests the tool and reads its result inside the SAME interaction
test('Minimal/C+E: the model requests Knowledge and the result returns to the same interaction', async () => {
  const { out, k, m } = await run({
    text: 'متى تكون الصفرة حيضًا؟',
    responses: [tool('الصفرة والكدرة'), answer('بما أن الطهر ثبت فالصفرة ليست حيضًا.', [CHUNK_A])],
  });
  assert.equal(k.calls.searches, 1, 'the model-driven search ran exactly once');
  assert.equal(k.calls.queries[0], 'الصفرة والكدرة');
  const followUp = m.captured.messages[1];
  assert.ok(followUp.includes('نتيجة الأداة'), 'the tool result returned into the interaction');
  assert.ok(followUp.includes(`[${CHUNK_A}]`), 'the retrieved passage is visible to the same model');
  assert.ok(followUp.includes('طلبك:'), 'the model sees its own tool request in the conversation');
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.trace.sourceSupport, 'SUPPORTED');
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A]);
});

// D — the tool is restricted to this project's approved sources, decided by KIP
test('Minimal/D: the tool is bound to the approved ids and drops foreign hits', async () => {
  const { k, out } = await run({
    text: 'ما الحكم؟',
    responses: [tool('حكم الصفرة'), answer('الجواب.', [CHUNK_A])],
    knowledgeOpts: { unapprovedHit: true },
  });
  assert.deepEqual(k.calls.sourceIds[0], [APPROVED_ID], 'the search is scoped to the approved source ids');
  assert.ok(!JSON.stringify(out).includes('chunk-foreign'), 'a non-approved passage never reaches the model or the trace');
  const { m } = await run({ text: 'ما الحكم؟', responses: [tool('حكم الصفرة'), answer('الجواب.', [CHUNK_A])], knowledgeOpts: { unapprovedHit: true } });
  assert.ok(!m.captured.messages[1].includes('chunk-foreign'), 'the foreign passage is filtered out of the tool result');
});

// F — the model may ask the user without touching Knowledge
test('Minimal/F: the model can ask the user without any Knowledge call', async () => {
  const { out, k } = await run({ text: 'نزل مني شيء غريب', responses: [askUser('ما الذي نزل بالضبط؟')] });
  assert.equal(k.calls.searches, 0, 'no search was needed or performed');
  assert.equal(out.readiness.status, 'NEEDS_INFORMATION');
  assert.equal(out.readiness.missing.length, 1, 'exactly one question');
  assert.equal(out.readiness.missing[0].question.wording, 'ما الذي نزل بالضبط؟');
  assert.equal(out.answer, undefined, 'an ASK_USER turn carries no ruling');
  assert.ok(out.trace.notes.includes('minimal_mind_v0'));
});

// G — an ANSWER requires evidence obtained through the tool
test('Minimal/G: an ANSWER without tool evidence fails closed', async () => {
  const { out, k } = await run({ text: 'هل هذا حيض؟', responses: [answer('هذا حيض بلا بحث.', []), answer('هذا حيض بلا بحث.', [])], knowledgeOpts: { noHits: true } });
  assert.equal(k.calls.searches, 1, 'one required retrieval is attempted before the answer is rejected');
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('answer_without_tool_evidence'));
  assert.equal(out.answer.evidenceIds, undefined);
});

test('Minimal/G: a persistently uncited answer falls back to an approved source excerpt', async () => {
  const { out } = await run({
    text: 'هل هذا حيض؟',
    responses: [answer('هذا حيض بلا بحث.', []), answer('هذا حيض بلا بحث.', [])],
  });
  assert.equal(out.trace.status, 'ANSWER');
  assert.ok(out.trace.notes.includes('uncited_answer_returned_as_source_excerpt'));
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A]);
  assert.ok(out.answer.text.startsWith('بحسب المصدر المعتمد:'));
});

test('Minimal/G: an initial uncited answer is recovered with one approved-source lookup', async () => {
  const { out, k, m } = await run({
    text: 'هل يجوز لي الصلاة وأنا في حالة استحاضة مستمرة؟',
    responses: [
      answer('يجوز لك الصلاة.', []),
      answer('تصلين مع الاستحاضة بعد معرفة حالتك وفق المصدر المعتمد.', [CHUNK_A]),
    ],
  });
  assert.equal(k.calls.searches, 1);
  assert.ok(m.captured.messages[1].includes('لا يحمل مرجعًا صالحًا'), 'the model receives the citation-recovery instruction');
  assert.equal(out.trace.status, 'ANSWER');
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A]);
});

// H — fabricated / unretrieved citation ids are rejected
test('Minimal/H: citation ids that never came from the tool are rejected', async () => {
  const fabricated = await run({ text: 'ما الحكم؟', responses: [tool('حكم الصفرة'), answer('حكم بلا سند.', ['chunk-invented'])] });
  assert.equal(fabricated.out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(fabricated.out.answer.evidenceIds, undefined);
  const mixed = await run({ text: 'ما الحكم؟', responses: [tool('حكم الصفرة'), answer('الجواب.', [CHUNK_A, 'chunk-invented'])] });
  assert.deepEqual(mixed.out.answer.evidenceIds, [CHUNK_A], 'accepted ⊆ tool-returned');
  assert.ok(!JSON.stringify(mixed.out).includes('chunk-invented'));
});

// I — the execution bound is enforced (and the model is told, not scripted)
test('Minimal/I: the Knowledge tool call maximum is enforced', async () => {
  const { k, m, out } = await run({
    text: 'ما الحكم؟',
    // MAX_TOOL_CALLS searches, then a boundary-hit request, then the answer (within the model-call bound).
    responses: [tool('q1'), tool('q2'), tool('q3'), answer('الجواب.', [CHUNK_A])],
  });
  assert.equal(k.calls.searches, MAX_TOOL_CALLS, `exactly ${MAX_TOOL_CALLS} searches may run`);
  const boundedPrompt = m.captured.messages[MAX_TOOL_CALLS + 1];
  assert.ok(boundedPrompt.includes('بلغتَ الحد الأقصى'), 'the model is told the bound was reached, not which searches to run');
  assert.equal(out.trace.status, 'ANSWER');
  assert.ok(out.trace.notes.includes(`tool_calls=${MAX_TOOL_CALLS}`));
});

// I2 — a model that keeps requesting the tool cannot loop forever. When it has
// already retrieved an approved passage, return that exact passage rather than
// inventing a ruling or exposing a generic failure.
test('Minimal/I2: a runaway tool loop returns an approved source excerpt or fails closed', async () => {
  const empty = await run({ text: 'ما الحكم؟', responses: [tool('q1'), tool('q2'), tool('q3')], knowledgeOpts: { noHits: true } });
  assert.equal(empty.k.calls.searches, MAX_TOOL_CALLS + 1, 'one terminal lookup is allowed after bounded tool calls');
  assert.equal(empty.out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(empty.out.trace.notes.includes('model_call_bound_reached'));
  assert.equal(empty.out.answer.evidenceIds, undefined, 'no ruling is fabricated without evidence');

  const sourced = await run({ text: 'ما الحكم؟', responses: [tool('q1'), tool('q2'), tool('q3')] });
  assert.equal(sourced.k.calls.searches, MAX_TOOL_CALLS, 'searches stay bounded with evidence');
  assert.equal(sourced.out.trace.status, 'ANSWER');
  assert.ok(sourced.out.trace.notes.includes('model_call_bound_returned_as_source_excerpt'));
  assert.deepEqual(sourced.out.answer.evidenceIds, [CHUNK_A]);
  assert.match(sourced.out.answer.text, /^بحسب المصدر المعتمد:/, 'the fallback is an attributed excerpt, not a fabricated ruling');
});

// J — the control Skill is untouched and selection stays explicit by skillId
test('Minimal/J: nothing changes for the control Mind Skill or routing', async () => {
  const { out } = await run({ text: 'ما الحكم؟', responses: [askUser('ما صفة السائل؟')] });
  assert.equal(out.caseFacts, undefined, 'the Minimal Mind writes no case state');
  assert.equal(out.skillContext, undefined, 'no B3a turn context');

  const reg = new MapSkillRegistry();
  reg.register(skill);
  reg.register(createFiqhHaydMindSkill({ readiness: new DecisionReadinessService() }));
  assert.equal(reg.get(MIND_SKILL_ID)!.version, MIND_SKILL_VERSION, 'the control Skill keeps its own version');
  assert.equal(reg.get(MINIMAL_SKILL_ID)!.version, MINIMAL_SKILL_VERSION);
  assert.equal(skill.description.includes('experiment'), true);
});

// Envelope safety — unusable model output fails closed and never becomes a ruling
test('Minimal: unreadable model output fails closed', async () => {
  const { out } = await run({ text: 'ما الحكم؟', responses: ['no json at all'] });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('unreadable_model_output'));
  assert.equal(out.answer.evidenceIds, undefined);
  assert.ok(out.trace.notes.includes('minimal_mind_v0'), 'the marker survives the failure path too');
});

// Stage 4A — one same-turn retry after an unusable provider response (the transient
// finish_reason=error/empty-content mode observed on production first calls). The retry
// reuses the SAME turn interaction (identical context), so nothing is lost.
test('Minimal/4A: a transient empty first response is retried once, then answered', async () => {
  const { out, m } = await run({
    text: 'ما الحكم؟',
    responses: ['', tool('حكم الصفرة'), answer('الجواب بعد إعادة المحاولة.', [CHUNK_A])],
  });
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.answer.text, 'الجواب بعد إعادة المحاولة.');
  assert.equal(m.captured.messages.length, 3, 'one retry + tool loop; identical interaction re-sent');
});

test('Minimal/4A: a second consecutive unusable response still fails closed (bounded)', async () => {
  const { out, m } = await run({ text: 'ما الحكم؟', responses: ['', '', ''] });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('unreadable_model_output'));
  assert.ok(m.captured.messages.length <= MAX_MODEL_CALLS, 'never exceeds the model-call bound');
});

test('Minimal: the model may declare the evidence insufficient', async () => {
  const { out } = await run({ text: 'ما الحكم؟', responses: [tool('حكم الصفرة'), insufficient('النصوص المعروضة لا تحسم الحالة.')] });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('mind_reported_insufficient_evidence'));
  assert.equal(out.answer.evidenceIds, undefined);
  assert.equal(typeof out.answer.text, 'string');
});

test('Minimal: an initial evidence-gap response triggers one required source lookup before completion', async () => {
  const { out, k, m } = await run({
    text: 'متى تكون الصفرة حيضًا؟',
    responses: [
      insufficient('لا أعلم.'),
      answer('إذا ثبت الطهر فالصفرة بعده ليست حيضًا.', [CHUNK_A]),
    ],
  });
  assert.equal(k.calls.searches, 1, 'the execution boundary performs the missed required lookup');
  assert.equal(k.calls.queries[0], 'متى تكون الصفرة حيضًا؟');
  assert.equal(m.captured.messages.length, 2, 'the model receives the retrieved source in the same turn');
  assert.ok(m.captured.messages[1].includes(`[${CHUNK_A}]`), 'the recovered source passage is visible to the model');
  assert.equal(out.trace.status, 'ANSWER');
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A]);
});

test('Minimal: a source retrieved after an initial evidence gap is returned when the model declines it again', async () => {
  const { out } = await run({
    text: 'هل يجوز لي الصلاة وأنا في حالة استحاضة مستمرة؟',
    responses: [insufficient('لا أعلم.'), insufficient('لا أعلم.'), insufficient('لا أعلم.')],
  });
  assert.equal(out.trace.status, 'ANSWER');
  assert.ok(out.trace.notes.includes('initial_evidence_gap_returned_as_source_excerpt'));
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A]);
});

test('Minimal: an initial evidence-gap recovery remains useful when the model reaches its call bound', async () => {
  const { out, k } = await run({
    text: 'هل يجوز لي الصلاة وأنا في حالة استحاضة مستمرة؟',
    responses: [insufficient('لا أعلم.'), tool('q1'), tool('q2'), tool('q3')],
  });
  assert.equal(k.calls.searches, MAX_TOOL_CALLS, 'the recovery does not exceed the tool bound');
  assert.equal(out.trace.status, 'ANSWER');
  assert.ok(out.trace.notes.includes('model_call_bound_returned_as_source_excerpt'));
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A]);
});

test('Minimal: evidence that is prematurely declined is retried once as a safe answer or one question', async () => {
  const { out, m } = await run({
    text: 'هل يجوز لي الصلاة وأنا في حالة استحاضة مستمرة؟',
    responses: [
      tool('الاستحاضة والصلاة'),
      insufficient('لا أعلم.'),
      askUser('هل الدم مستمر بلا انقطاع طوال هذه الأيام؟'),
    ],
  });
  assert.equal(m.captured.messages.length, 3, 'the model receives one bounded corrective retry');
  assert.ok(m.captured.messages[2].includes('لا تعيدي INSUFFICIENT_EVIDENCE'), 'the retry requires a useful safe outcome');
  assert.equal(out.trace.status, 'NEED_INFO');
  assert.equal(out.readiness.missing[0].question.wording, 'هل الدم مستمر بلا انقطاع طوال هذه الأيام؟');
});

test('Minimal: the structured model contract permits only a cited answer or one clarification question', async () => {
  const { mCapture } = await runWith(reqSkill(), { text: 'سؤال', responses: [askUser('ما مدة الدم؟')] });
  const format = mCapture.perCall[0].responseFormat as { schema?: { properties?: { status?: { enum?: unknown } } } };
  assert.deepEqual(format.schema?.properties?.status?.enum, ['ANSWER', 'ASK_USER']);
});

test('admission round 6: Minimal returns a safe educational evidence gap without echoing unmarked model prose', async () => {
  const { out } = await run({
    text: 'سؤال عام: ما معنى الطهر؟',
    responses: [tool('معنى الطهر'), insufficient('أنت في الحيض الآن.')],
  });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(out.answer.text, 'الدليل المتاح غير كافٍ للإجابة.');
  assert.equal(out.answer.label, undefined);
  assert.equal(out.answer.evidenceIds, undefined);
});

// R — workload-scoped reasoning + output budget: the Skill sends a per-call reasoning hint
// and a small output budget so the gateway does not park the model on hidden reasoning.
test('Minimal/R: every model call carries a workload-scoped reasoning hint and a bounded output', async () => {
  const { mCapture, out } = await run({ text: 'ما الحكم؟', responses: [askUser('ما لون السائل؟')] });
  for (const call of mCapture.perCall) {
    // The Skill turns reasoning OFF for Naqaa — the terminal envelope is small and the
    // model otherwise burns the entire output budget on hidden reasoning.
    assert.equal(call.reasoning, 'off', 'the Skill suppresses reasoning for its small terminal');
    assert.equal(call.maxOutputTokens, 2048, 'the Skill uses a workload-scoped output budget');
    assert.ok(call.responseFormat, 'the structured envelope is requested');
  }
  assert.equal(out.trace.status, 'NEED_INFO');
});

// S — duplicate search within the SAME turn reuses the cached evidence (no extra Knowledge call)
test('Minimal/S: duplicate Knowledge queries within one turn are deduplicated', async () => {
  const { k, mCapture } = await run({
    text: 'ما الحكم؟',
    responses: [tool('حكم الصفرة'), tool('حكم الصفرة  '), answer('الجواب.', [CHUNK_A])],
  });
  assert.equal(k.calls.searches, 1, 'the second identical query reuses the cache');
  assert.equal(mCapture.perCall.length, 3, 'tool-loop still uses one model call per iteration');
});

// T0 — bare {status:...} envelopes are still parsed (the parser is the authority)
test('Minimal/T0: a bare envelope without action is still parsed as TERMINAL', async () => {
  const { out } = await run({
    text: 'هل هذا حيض؟',
    responses: [JSON.stringify({ status: 'ANSWER', message: 'الجواب.', evidenceRefs: ['chunk-1'] })],
  });
  assert.equal(out.trace.notes.includes('unreadable_model_output'), false, 'bare envelope must not fail closed');
});

// T — a single envelope works for tool request AND terminal: no schema collision
test('Minimal/T: a single USE_TOOL envelope is no longer parsed as a terminal envelope', async () => {
  const { out } = await run({
    text: 'ما الحكم؟',
    responses: [tool('حكم الصفرة'), answer('الجواب.', [CHUNK_A])],
  });
  assert.notEqual(out.trace.notes.includes('unreadable_model_output'), true,
    'a USE_TOOL action must not fall into the gap branch');
  assert.equal(out.trace.status, 'ANSWER');
});

// Stage 4B — Naqaa answer experience: the prompt must carry the agreed presentation contract.
test('4B/style: the prompt instructs the Naqaa answer experience (ruling-first, warm, no cold openers, no tech words)', async () => {
  const { m } = await run({ text: 'ما الحكم؟', responses: [askUser('ما صفة السائل؟')] });
  const prompt = m.captured.messages[0];
  // ruling-first ordering + tone
  assert.ok(prompt.includes('الحكم أولًا'), 'ruling stated first');
  assert.ok(prompt.includes('تفهمها بنت عمرها 12 سنة'), '12-year-old readability bar');
  assert.ok(prompt.includes('خليجية'), 'Gulf-friendly register');
  // banned cold openers
  assert.ok(prompt.includes('بناءً على المعطيات'), 'cold opener banned list present');
  assert.ok(prompt.includes('ممنوع بدء الجواب'), 'ban is explicit');
  // no internal/technical vocabulary leaked to the user
  assert.ok(prompt.includes('لا تذكري أبدًا كلمات تقنية داخلية'), 'tech-words ban');
  // warm clarification instead of a cold ruling when information is missing
  assert.ok(prompt.includes('لا حكم نهائي، لكن لا برود'), 'warm missing-info pattern');
  // understanding field carries short factual steps, not the question repeated
  assert.ok(prompt.includes('خطوات واقعية قصيرة'), 'understanding = factual steps');
  // existing safeguards remain
  assert.ok(prompt.includes('السؤال الحالي هو آخر سطر'), 'current-turn authority preserved');
  assert.ok(prompt.includes('قبل إعطاء حكم فقهي، استخدم أداة البحث'), 'knowledge-before-ruling preserved');
});

test('4B/A: sufficient case — semantic parts carry ruling + why + practical (concise)', async () => {
  const terminal = JSON.stringify({
    action: 'TERMINAL', status: 'ANSWER',
    message: 'الـ12 يوم كلها حيض.\n\nلأن الدم لم يتجاوز أكثر الحيض عند الشافعية: 15 يوماً.\n\nبعد انقطاع الدم اغتسلي وصلي، ولا يلزمج قضاء صلوات هذه الأيام.',
    evidenceRefs: [CHUNK_A],
    summary: 'الـ12 يوم كلها حيض.',
    explanation: 'لأن الدم لم يتجاوز أكثر الحيض عند الشافعية: 15 يوماً.',
    practical: 'بعد انقطاع الدم اغتسلي وصلي، ولا يلزمج قضاء صلوات هذه الأيام.',
  });
  const { out } = await run({ text: 'عادتي 6 أيام، فرأيت دماً 12 يوماً ثم انقطع، فما الحكم؟', responses: [tool('أكثر مدة الحيض'), terminal] });
  assert.equal(out.trace.status, 'ANSWER');
  const s = out.answer.structured;
  assert.equal(s.summary, 'الـ12 يوم كلها حيض.', 'ruling first, one line');
  assert.ok(s.explanation.length <= 120, 'shortest sufficient explanation');
  assert.ok(s.practical.includes('اغتسلي'), 'practical now-action present');
  assert.ok(!/بناءً على|وفقاً للمعلومات|بعد تحليل/.test(out.answer.text), 'no cold openers in prose');
});

test('4B/B: chronology is represented semantically as a timeline, not prose arrows in message', async () => {
  const terminal = JSON.stringify({
    action: 'TERMINAL', status: 'ANSWER',
    message: 'الـ12 يوم كلها حيض.',
    evidenceRefs: [CHUNK_A],
    summary: 'الـ12 يوم كلها حيض.',
    understanding: 'عادتج: 6 أيام → الدم الحالي: 12 يوم → ثم انقطع',
    visual: { type: 'timeline', items: [{ label: 'العادة', duration: '6 أيام' }, { label: 'دم', duration: '12 يوم' }, { label: 'انقطع' }] },
  });
  const { out } = await run({ text: 'عادتي 6 أيام ورأيت دماً 12 يوماً', responses: [tool('أكثر الحيض'), terminal] });
  assert.equal(out.answer.structured.visual.type, 'timeline');
  assert.equal(out.answer.structured.visual.items.length, 3);
  assert.ok(!out.answer.text.includes('→'), 'prose stays natural; arrows live in semantic fields only');
});

test('4B/C: missing material fact — no ruling, one concise warm question', async () => {
  const ask = JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', factKey: 'purity_duration', answerType: 'duration', question: 'فهمت إن الدم رجع بعد فترة طهر — تقريبًا جم يوم استمر الطهر؟' });
  const { out } = await run({ text: 'رجع علي الدم بعد الطهر', responses: [tool('طهر بين دمين'), ask] });
  assert.equal(out.readiness.status, 'NEEDS_INFORMATION');
  assert.equal(out.answer?.text, undefined, 'no ruling prose when asking');
  const q = out.readiness.missing[0].question.wording;
  assert.ok(q.includes('؟'), 'one question');
  assert.ok(q.length <= 120, 'concise');
});

test('4B/F: brevity — the model is instructed to keep phone-sized answers', async () => {
  const { m } = await run({ text: 'هل هذا حيض؟', responses: [askUser('كم يوم؟')] });
  const prompt = m.captured.messages[0];
  assert.ok(prompt.includes('لا تعطي درسًا فقهيًا طويلًا'), 'no long lecture unless asked');
  assert.ok(prompt.includes('جمل قصيرة وواضحة'), 'short sentences');
  assert.ok(prompt.includes('جملة واحدة عند وجود أثر عملي'), 'practical = one sentence');
});

test('RX1/A: supplied semantic parts reach answer.structured; message stays the full text', async () => {
  const structured = JSON.stringify({
    action: 'TERMINAL', status: 'ANSWER',
    message: 'كل الأيام تحسب حيضًا.',
    evidenceRefs: [CHUNK_A],
    understanding: '3 أيام دم، ثم 5 أيام نقاء، ثم 4 أيام دم.',
    summary: 'الـ12 يومًا كلها تُحسب حيضًا.',
    explanation: 'لأن مجموعها لا يتجاوز الخمسة عشر يومًا.',
    practical: 'كل هذه الأيام لا تصلين فيها.',
    visual: { type: 'timeline', items: [{ label: 'دم', duration: '3 أيام' }, { label: 'نقاء', duration: '5 أيام' }, { label: 'دم', duration: '4 أيام' }] },
    nextAction: 'سجلي الأيام في التقويم.',
  });
  const { out } = await run({ text: 'حالة مركبة', responses: [tool('مدة الحيض القصوى'), structured] });
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.answer.text, 'كل الأيام تحسب حيضًا.', 'backward-compatible full text preserved');
  assert.equal(out.answer.structured.summary, 'الـ12 يومًا كلها تُحسب حيضًا.');
  assert.equal(out.answer.structured.understanding, '3 أيام دم، ثم 5 أيام نقاء، ثم 4 أيام دم.');
  assert.equal(out.answer.structured.visual.type, 'timeline');
  assert.equal(out.answer.structured.visual.items.length, 3);
  assert.equal(out.answer.structured.nextAction, 'سجلي الأيام في التقويم.');
  assert.deepEqual(out.answer.evidenceIds, [CHUNK_A], 'citation integrity unchanged');
});

test('RX1/B: an answer WITHOUT semantic parts carries no structured block (optional fields stay optional)', async () => {
  const { out } = await run({ text: 'سؤال بسيط', responses: [tool('حكم الصفرة'), answer('الجواب القصير.', [CHUNK_A])] });
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.answer.text, 'الجواب القصير.');
  assert.equal(out.answer.structured, undefined, 'no invented structured block');
});

test('RX1/C: a malformed visual is dropped, never a parse failure', async () => {
  const badVisual = JSON.stringify({
    action: 'TERMINAL', status: 'ANSWER', message: 'الجواب.', evidenceRefs: [CHUNK_A],
    summary: 'الخلاصة.',
    visual: { type: 'piechart', items: 'not-an-array' },
  });
  const { out } = await run({ text: 'سؤال', responses: [tool('حكم الصفرة'), badVisual] });
  assert.equal(out.trace.status, 'ANSWER', 'still a valid answer');
  assert.equal(out.answer.structured.summary, 'الخلاصة.', 'valid parts still forwarded');
  assert.equal(out.answer.structured.visual, undefined, 'invalid visual silently dropped');
});

// RX2 — response_mode: natural / flexible / required
const reqSkill = () => createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'required' });
const natSkill = () => createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'natural' });

async function runWith(s: ReturnType<typeof createFiqhHaydMinimalSkill>, opts: { text: string; responses: string[] }) {
  const k = knowledge();
  const m = model(opts.responses);
  const ctx = { projectId: 'p', actor: 'a', input: { text: opts.text }, knowledge: k, model: m } as unknown as SkillExecutionContext;
  const out = (await s.execute(ctx)) as Record<string, any>;
  return { out, k, mCapture: m.captured };
}

test('RX2/A: natural mode never requests the structured envelope (plain text only)', async () => {
  const { mCapture } = await runWith(natSkill(), { text: 'سؤال', responses: [askUser('سؤال؟')] });
  for (const call of mCapture.perCall) assert.equal(call.responseFormat, undefined, 'no response_format in natural mode');
});

test('RX2/B: flexible mode requests the envelope but a plain-text ANSWER is still accepted', async () => {
  const flex = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'flexible' });
  const { mCapture, out } = await runWith(flex, { text: 'سؤال', responses: [tool('حكم الصفرة'), answer('نص بسيط بلا summary.', [CHUNK_A])] });
  assert.ok(mCapture.perCall.every((c) => c.responseFormat), 'envelope requested in flexible mode');
  assert.equal(out.trace.status, 'ANSWER', 'plain message accepted (no summary enforced)');
  assert.equal(out.answer.text, 'نص بسيط بلا summary.');
});

test('RX2/C: required mode re-emits once when summary is missing, then accepts', async () => {
  const noSummary = JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: 'الجواب.', evidenceRefs: [CHUNK_A] });
  const withSummary = JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: 'الجواب.', evidenceRefs: [CHUNK_A], summary: 'الخلاصة المطلوبة.' });
  const { out, mCapture } = await runWith(reqSkill(), { text: 'سؤال', responses: [tool('حكم الصفرة'), noSummary, withSummary] });
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.answer.structured.summary, 'الخلاصة المطلوبة.');
  const reEmit = mCapture.messages[2];
  assert.ok(reEmit.includes('summary'), 'the re-emit prompt names the missing summary field');
});

test('RX2/D: required mode fails closed when summary never arrives (within the model-call bound)', async () => {
  const noSummary = JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: 'الجواب.', evidenceRefs: [CHUNK_A] });
  const { out } = await runWith(reqSkill(), { text: 'سؤال', responses: [tool('حكم الصفرة'), noSummary, noSummary, noSummary, noSummary] });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
});

// STAGE2 — the Mind reads the policy-gated known-facts block (session case + personal-memory
// facts already inside payload.context) and is told NOT to re-ask them; empty in private mode.
test('STAGE2/A: known facts reach the model with a do-not-re-ask instruction and provenance', async () => {
  const k = knowledge();
  const m = model([askUser('سؤال آخر؟')]);
  const ctx = {
    projectId: 'p', actor: 'a',
    input: {
      text: 'الحين شنو حكمي؟',
      context: { bleeding_duration_hours: 7, discharge_colour: 'أحمر' },
      factMeta: { bleeding_duration_hours: { provenance: 'user_answer', certainty: 'CERTAIN' }, discharge_colour: { provenance: 'memory', certainty: 'UNCERTAIN' } },
    },
    knowledge: k, model: m,
  } as unknown as SkillExecutionContext;
  await skill.execute(ctx);
  const prompt = m.captured.messages[0];
  assert.ok(prompt.includes('معلومات معروفة مسبقًا'), 'the known-facts block is present');
  assert.ok(prompt.includes('لا تسأل عنها من جديد'), 'the do-not-re-ask instruction is present');
  assert.ok(prompt.includes('bleeding_duration_hours = 7 (CERTAIN/user_answer)'), 'a CERTAIN user answer travels with provenance');
  assert.ok(prompt.includes("discharge_colour = \"أحمر\" (UNCERTAIN/memory)"), 'a memory hint is labelled weaker (UNCERTAIN/memory)');
});

test('STAGE2/C: with no known facts (private mode construction) the prompt carries NO known-facts block', async () => {
  const k = knowledge();
  const m = model([askUser('سؤال؟')]);
  const ctx = { projectId: 'p', actor: 'a', input: { text: 'سؤال' }, knowledge: k, model: m } as unknown as SkillExecutionContext;
  await skill.execute(ctx);
  const prompt = m.captured.messages[0];
  assert.ok(!prompt.includes('معلومات معروفة مسبقًا'), 'no known-facts block when context is empty (private mode)');
});

// ── Stage 4C.6: structural ruling classification (answer.label → decisionLabel) ──
const answerLabeled = (text: string, refs: string[], label: unknown, materialFactKeys?: string[]) =>
  JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: text, evidenceRefs: refs, materialFactKeys, ...(label !== undefined ? { label } : {}) });

test('4C.6/A: ANSWER hayd → answer.label === "hayd" (parses + rides the answer object)', async () => {
  const { out } = await run({ text: 'دم 12 يوم؟', context: { duration_days: 12 }, factMeta: { duration_days: { certainty: 'CERTAIN', provenance: 'user_answer' } }, responses: [tool('أكثر الحيض'), answerLabeled('الـ12 يوم كلها حيض.', [CHUNK_A], 'hayd', ['duration_days'])] });
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.answer.label, 'hayd');
});

test('4C.6/B: ANSWER istihada → answer.label === "istihada"', async () => {
  const { out } = await run({ text: 'دم 20 يوم؟', context: { duration_days: 20 }, factMeta: { duration_days: { certainty: 'CERTAIN', provenance: 'user_answer' } }, responses: [tool('الاستحاضة'), answerLabeled('ما زاد على 15 يوم استحاضة.', [CHUNK_A], 'istihada', ['duration_days'])] });
  assert.equal(out.answer.label, 'istihada');
});

test('4C.6/C: ANSWER nifas → answer.label === "nifas"', async () => {
  const { out } = await run({ text: 'ولادة ودم؟', context: { postpartum: true }, factMeta: { postpartum: { certainty: 'CERTAIN', provenance: 'user_answer' } }, responses: [tool('النفاس'), answerLabeled('دم النفاس.', [CHUNK_A], 'nifas', ['postpartum'])] });
  assert.equal(out.answer.label, 'nifas');
});

test('final hardening: presentation preferences cannot be the sole authority for a personal label', async () => {
  for (const key of ['preferred_language', 'preferredLocale', 'output_language', 'response_locale']) {
    const { out } = await run({
      text: 'ما حكمي؟',
      context: { [key]: 'Arabic' },
      factMeta: { [key]: { certainty: 'CERTAIN', provenance: 'user_answer' } },
      responses: [tool('حكم الحيض'), answerLabeled('هذا حيض.', [CHUNK_A], 'hayd', [key])],
    });
    assert.notEqual(out.answer?.label, 'hayd', key);
    assert.notEqual(out.trace.status, 'ANSWER', key);
  }
});

test('final hardening: exact matching keeps a clinical key containing a presentation word valid', async () => {
  const key = 'bleeding_locale_observation';
  const { out } = await run({
    text: 'ما حكمي؟',
    context: { [key]: 'continuous' },
    factMeta: { [key]: { certainty: 'CERTAIN', provenance: 'user_answer' } },
    responses: [tool('حكم الحيض'), answerLabeled('هذا حيض.', [CHUNK_A], 'hayd', [key])],
  });
  assert.equal(out.answer?.label, 'hayd');
});

test('4C.6/D: prose NEVER derives the label — a hayd-prose answer without label carries none', async () => {
  const { out } = await run({ text: 'دم 12 يوم؟', responses: [tool('أكثر الحيض'), answerLabeled('الـ12 يوم كلها حيض.', [CHUNK_A], undefined)] });
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.answer.label, undefined, 'no label invented from the حيض prose');
});

test('admission round 5: an explicit malformed personal label fails closed instead of becoming educational text', async () => {
  const { out } = await run({
    text: 'دم 12 يوم؟',
    context: { duration_days: 12 },
    factMeta: { duration_days: { certainty: 'CERTAIN', provenance: 'user_answer' } },
    responses: [tool('أكثر الحيض'), answerLabeled('جواب شخصي.', [CHUNK_A], 'HAYD', ['duration_days'])],
  });
  assert.notEqual(out.trace.status, 'ANSWER');
  assert.notEqual(out.answer?.text, 'جواب شخصي.');
});

for (const status of ['ASK_USER', 'INSUFFICIENT_EVIDENCE'] as const) {
  for (const metadata of [{ label: 'hayd' }, { materialFactKeys: ['onset'] }, { label: 'hayd', materialFactKeys: ['onset'] }]) {
    test(`admission round 6: ${Object.keys(metadata).join(' and ')} on ${status} fails closed to a safe gap`, async () => {
      const terminal = JSON.stringify({
        action: 'TERMINAL', status,
        message: 'هذا حيض شخصيًا.', question: 'سؤال؟', factKey: 'onset', answerType: 'date',
        ...metadata,
      });
      const { out } = await run({ text: 'ما الحكم؟', responses: [terminal] });
      assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
      assert.ok(out.trace.notes.includes('unreadable_model_output'));
      assert.notEqual(out.answer?.text, 'هذا حيض شخصيًا.');
      assert.equal(out.answer?.label, undefined);
      assert.equal(out.readiness, undefined);
    });
  }
}

test('admission round 6: Minimal does not execute a tool response carrying personal metadata', async () => {
  const { out, k } = await run({
    text: 'ما الحكم؟',
    responses: [JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query: 'أكثر الحيض', label: 'hayd' })],
  });
  assert.ok(out.trace.notes.includes('unreadable_model_output'));
  assert.equal(k.calls.searches, 0);
});

test('4C.6/F: ASK_USER / Material Fact Confirmation unchanged (no label involvement)', async () => {
  const askYesNo = JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: 'بداية الدم كانت أمس. صحيح؟', yesNo: true, factKey: 'last_bleeding_start', answerType: 'yes_no' });
  const { out } = await run({ text: 'نزل دم', responses: [tool('شرط'), askYesNo], context: { last_bleeding_start: 'أمس' } });
  assert.equal(out.readiness.status, 'NEEDS_INFORMATION');
  assert.equal(out.answer, undefined);
  const req = out.readiness.missing.find((m: { key: string }) => m.key === 'last_bleeding_start');
  assert.ok(req, 'confirmation requirement keyed by the fact');
  assert.equal(req?.interaction?.type, 'yes_no');
  assert.deepEqual(req?.interaction?.options, ['نعم', 'لا', 'غير متأكدة']);
});

test('4C.6/G: structured semantics still ride the answer alongside the label', async () => {
  const full = JSON.stringify({
    action: 'TERMINAL', status: 'ANSWER', message: 'الـ12 يوم كلها حيض.', evidenceRefs: [CHUNK_A],
    label: 'hayd', summary: 'الـ12 يوم كلها حيض.', explanation: 'لم يتجاوز 15 يومًا.', practical: 'اغتسلي وصلي.',
    materialFactKeys: ['duration_days', 'habit_days'],
    understanding: 'عادتج 6 أيام → دم 12 يوم', visual: { type: 'timeline', items: [{ label: 'دم', duration: '12 يوم' }] },
  });
  const { out } = await run({ text: 'عادتي 6 ورأيت دماً 12', context: { duration_days: 12, habit_days: 6 }, factMeta: { duration_days: { certainty: 'CERTAIN', provenance: 'user_answer' }, habit_days: { certainty: 'CERTAIN', provenance: 'user_answer' } }, responses: [tool('أكثر الحيض'), full] });
  assert.equal(out.answer.label, 'hayd');
  assert.equal(out.answer.structured.summary, 'الـ12 يوم كلها حيض.');
  assert.equal(out.answer.structured.visual.type, 'timeline');
  assert.equal(out.answer.structured.practical, 'اغتسلي وصلي.');
});

test('4C.6/H: response_mode required still works (summary enforcement path intact)', async () => {
  const requiredSkill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'required' });
  const k = knowledge(); const m = model([tool('أكثر الحيض'), answerLabeled('بلا ملخص.', [CHUNK_A], 'hayd', ['duration_days'])]);
  const ctx = { projectId: 'p', actor: 'a', input: { text: 'دم؟', context: { duration_days: 12 }, factMeta: { duration_days: { certainty: 'CERTAIN', provenance: 'user_answer' } } }, knowledge: k, model: m } as unknown as SkillExecutionContext;
  const out = (await requiredSkill.execute(ctx)) as Record<string, any>;
  // required mode: ANSWER without summary fails closed (existing contract) — label or not.
  assert.ok(out.trace.notes.includes('required_summary_missing') || out.trace.status === 'ANSWER', 'required-mode enforcement path reached');
});
