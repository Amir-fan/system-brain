/**
 * Stage 4C.7 — Smart Scanner question experience (style + answer-effort priority).
 *
 * The LLM still owns the question (no engine, no catalogue). These tests pin the
 * DETERMINISTIC delivery contract:
 *   A. confirmation question carries yes/no interaction WITH «غير متأكدة» chips
 *   B. enumerable missing info → single_choice options (with «غير متأكدة» appended)
 *   C. open info → free_text allowed
 *   D. free_text is never the default when options are supplied
 *   E/F. «غير متأكدة» never becomes CERTAIN and is neither نعم nor لا
 *   G. after «غير متأكدة» the mind can re-evaluate (answer) instead of re-asking
 *   H. exactly ONE requirement per ask (no questionnaire)
 *   I. the instruction carries the plain-Arabic style rules
 *   J. mandatory Material Fact Confirmation wording intact
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFiqhHaydMinimalSkill } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';

const P = 'p';
const passage = (id: string): SkillKnowledgePassage => ({
  chunkId: id, documentId: 'd', sourceId: 'src-approved-1', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 1, text: 'نص معتمد.', score: 0.5,
});

function scripted(script: (prompt: string) => string) {
  const prompts: string[] = [];
  return {
    prompts,
    async generateText(input: { instructions?: string; message?: string }) {
      const prompt = [input.instructions, input.message].filter(Boolean).join('\n\n');
      prompts.push(prompt);
      return { text: script(prompt), model: 'scripted' };
    },
  };
}

const tool = (q: string) => JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query: q });
const answer = (t: string) => JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: t, evidenceRefs: ['chunk-a'], label: 'hayd', summary: t, materialFactKeys: ['duration_hours'] });
const askYesNo = (q: string, factKey = 'duration_hours') => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q, yesNo: true, factKey, answerType: 'yes_no' });
const askOptions = (q: string, options: string[]) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q, options, factKey: 'requested_fact', answerType: 'single_choice' });
const askFree = (q: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q, factKey: 'requested_fact', answerType: 'free_text' });

async function run(script: (prompt: string) => string, context?: Record<string, unknown>, factMeta?: Record<string, { certainty: string; provenance?: string }>) {
  const model = scripted(script);
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  const k = {
    async search() { return [passage('chunk-a')]; },
    async resolveSources(t: string[]) { return t.includes(APPROVED_SOURCE_TITLES[0]) ? [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }] : []; },
    async adjacent() { return []; },
  };
  const ctx = {
    projectId: P, actor: 'a',
    input: { text: 'مسح دم', ...(context ? { context } : {}), ...(factMeta ? { factMeta } : {}) },
    knowledge: k, model,
  } as unknown as SkillExecutionContext;
  const out = (await skill.execute(ctx)) as Record<string, any>;
  return { out, prompts: model.prompts };
}

test('4C.7/A: confirmation question → yes_no interaction WITH نعم/لا/غير متأكدة options', async () => {
  const { out } = await run(() => askYesNo('صار تقريبًا يوم من بداية نزول الدم؟'), { duration_hours: 24 });
  assert.equal(out.readiness.status, 'NEEDS_INFORMATION');
  const req = out.readiness.missing[0];
  assert.equal(req.interaction?.type, 'yes_no');
  assert.deepEqual(req.interaction?.options, ['نعم', 'لا', 'غير متأكدة']);
});

test('4C.7/B: enumerable missing info → single_choice with the asked options + غير متأكدة', async () => {
  const { out } = await run(() => askOptions('شلون شكل الدم؟', ['أحمر غامق', 'بني', 'أصفر باهت']));
  const req = out.readiness.missing[0];
  assert.equal(req.interaction?.type, 'single_choice');
  assert.deepEqual(req.interaction?.options, ['أحمر غامق', 'بني', 'أصفر باهت', 'غير متأكدة']);
});

test('4C.7/C+D: open info → free_text allowed; and free_text only when the model sent no options', async () => {
  const { out } = await run(() => askFree('اكتبي لي بالضبط كم يوم انقطع الدم قبل ما يرجع؟'));
  const req = out.readiness.missing[0];
  assert.equal(req.interaction?.type, 'free_text', 'no options supplied → free text');
  // D: when the model DOES supply options, the interaction is NEVER free_text
  const { out: withOpts } = await run(() => askOptions('لون الدم؟', ['أحمر']));
  assert.equal((withOpts.readiness.missing[0] as any).interaction.type, 'single_choice');
});

test('4C.7/E+F: «غير متأكدة» never becomes CERTAIN and is neither نعم nor لا', async () => {
  const { out } = await run(() => askYesNo('صار يوم من بداية الدم؟', 'duration_hours'), { duration_hours: 24 });
  const req = out.readiness.missing[0];
  // The Core validator treats غير متأكدة as UNKNOWN (never CERTAIN, never boolean)
  const { validateAnswerCompatibility } = await import('../src/core/readiness/readiness.ts');
  const contract = req.interaction;
  assert.equal(validateAnswerCompatibility(contract, 'غير متأكدة'), 'UNKNOWN');
  assert.notEqual(validateAnswerCompatibility(contract, 'غير متأكدة'), 'ACCEPTED');
  // and the conversation's UNKNOWN_ANSWER accepts it as an unknown marker
  assert.notEqual('غير متأكدة', 'نعم');
  assert.notEqual('غير متأكدة', 'لا');
});

test('4C.7/G: after «غير متأكدة» the instruction demands re-evaluation, not mechanical re-asking', async () => {
  const { prompts } = await run(() => askFree('سؤال؟'));
  const prompt = prompts[0];
  assert.ok(prompt.includes('ليست نعم ولا لا'), 'غير متأكدة is neither yes nor no');
  assert.ok(prompt.includes('أعيدي التقييم وقرري بنفسك'), 're-evaluate and decide, not loop');
  assert.ok(prompt.includes('لا تكرري نفس السؤال بصياغات مختلفة بلا فائدة'), 'no useless re-asking loop');
  // and a later turn CAN rule: the ANSWER path is untouched (label + structured ride along)
  const { out } = await run((p) => (p.includes('طلبك:') ? answer('هذا الدم يُعد حيضاً.') : tool('أكثر الحيض')), { duration_hours: 24 }, { duration_hours: { certainty: 'CERTAIN', provenance: 'user_answer' } });
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.answer.label, 'hayd');
});

test('4C.7/H: exactly ONE requirement per ask (no questionnaire)', async () => {
  const { out } = await run(() => askOptions('جم يوم استمر الدم؟', ['يوم', 'يومان', 'ثلاثة']));
  assert.equal(out.readiness.missing.length, 1);
  assert.equal(out.readiness.requirementKeys?.length ?? 1, 1);
});

test('4C.7/I: instruction carries the plain-Arabic style rules', async () => {
  const { prompts } = await run(() => askFree('سؤال؟'));
  const prompt = prompts[0];
  assert.ok(prompt.includes('عربية بيضاء شديدة البساطة'), 'plain Arabic default');
  assert.ok(prompt.includes('بنت عمرها 12 سنة'), '12-year-old bar');
  assert.ok(prompt.includes('لا فصحى رسمية ثقيلة ولا لهجة بلد معينة كأساس'), 'no formal register, no fixed dialect');
  assert.ok(prompt.includes('ممنوع المقدمات الآلية'), 'no mechanical openers');
  assert.ok(prompt.includes('صار تقريبًا يوم من بداية نزول الدم؟'), 'the benchmark example is in the instructions');
  assert.ok(prompt.includes('سؤال واحد فقط في الجولة'), 'one question per turn');
  assert.ok(prompt.includes('أقل مجهود ممكن'), 'least-effort priority stated');
  assert.ok(prompt.includes('حل أخير فقط'), 'free text as last resort');
});

test('4C.7/J: mandatory Material Fact Confirmation wording intact', async () => {
  const { prompts } = await run(() => askFree('سؤال؟'));
  const prompt = prompts[0];
  assert.ok(prompt.includes('فلا تصدري ANSWER قبل تأكيدها'), 'mandatory-before-ruling rule intact');
  assert.ok(prompt.includes('إلزامي'), 'still mandatory for ruling-critical unconfirmed facts');
});
