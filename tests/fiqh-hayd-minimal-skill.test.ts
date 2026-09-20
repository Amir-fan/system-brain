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

function knowledge(opts: { unapprovedHit?: boolean } = {}) {
  const calls = { resolves: 0, searches: 0, sourceIds: [] as unknown[], queries: [] as string[] };
  return {
    calls,
    async search(input: { query: string; topK?: number; sourceIds?: string[] }) {
      calls.searches += 1;
      calls.queries.push(input.query);
      calls.sourceIds.push(input.sourceIds);
      const hits = [passage(CHUNK_A)];
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
      captured.messages.push(String(input.message ?? ''));
      captured.perCall.push(input);
      return { text: responses[Math.min(captured.messages.length - 1, responses.length - 1)] ?? '{}', model: 'scripted-model' };
    },
  };
}

async function run(opts: {
  text: string;
  responses: string[];
  recentTurns?: Array<{ role: string; text: string }>;
  knowledgeOpts?: { unapprovedHit?: boolean };
}) {
  const k = knowledge(opts.knowledgeOpts ?? {});
  const m = model(opts.responses);
  const ctx = {
    projectId: 'p', actor: 'a',
    input: { text: opts.text, recentTurns: opts.recentTurns ?? [] },
    knowledge: k, model: m,
  } as unknown as SkillExecutionContext;
  const out = (await skill.execute(ctx)) as Record<string, any>;
  return { out, k, m, mCapture: (m as unknown as { captured: { perCall: Array<Record<string, unknown>> } }).captured };
}

const tool = (query: string) => JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query });
const askUser = (question: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question });
const answer = (text: string, refs: string[]) => JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: text, evidenceRefs: refs });
const insufficient = (text: string) => JSON.stringify({ action: 'TERMINAL', status: 'INSUFFICIENT_EVIDENCE', message: text });
const askTool = (q: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q });

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
  assert.ok(!prompt.includes('CERTAIN'), 'no fact-certainty schema is imposed');
  assert.ok(!prompt.includes('حقائق معروفة'), 'no fact block is imposed');
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
  const { out, k } = await run({ text: 'هل هذا حيض؟', responses: [answer('هذا حيض بلا بحث.', [CHUNK_A])] });
  assert.equal(k.calls.searches, 0);
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('answer_without_tool_evidence'));
  assert.equal(out.answer.evidenceIds, undefined);
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

// I2 — a model that keeps requesting the tool cannot loop forever
test('Minimal/I2: a runaway tool loop is stopped by the model-call bound', async () => {
  const { out, k } = await run({ text: 'ما الحكم؟', responses: [tool('q1'), tool('q2'), tool('q3')] });
  assert.equal(k.calls.searches, MAX_TOOL_CALLS, 'searches stay bounded');
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('model_call_bound_reached'));
  assert.ok(out.trace.notes.includes(`model_calls=${MAX_MODEL_CALLS}`));
  assert.equal(out.answer.evidenceIds, undefined, 'no ruling is fabricated');
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

test('Minimal: the model may declare the evidence insufficient', async () => {
  const { out } = await run({ text: 'ما الحكم؟', responses: [tool('حكم الصفرة'), insufficient('النصوص المعروضة لا تحسم الحالة.')] });
  assert.equal(out.trace.status, 'INSUFFICIENT_EVIDENCE');
  assert.ok(out.trace.notes.includes('mind_reported_insufficient_evidence'));
  assert.equal(out.answer.evidenceIds, undefined);
  assert.equal(typeof out.answer.text, 'string');
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

// RX1 — semantic parts are forwarded into answer.structured (only when supplied)
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
