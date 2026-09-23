/**
 * Material Fact Confirmation (Stage 4B+ / 4C) — bounded regression tests.
 *
 * The LLM DECIDES when a material fact needs confirmation (no question engine,
 * no fixed list). KIP's deterministic responsibilities, proven here:
 *   1. the prompt carries the confirmation contract (when it may ask, one fact,
 *      never re-ask confirmed, never secondary facts);
 *   2. fact provenance/certainty tags travel to the model (evidence/UNCERTAIN vs
 *      user_answer/CERTAIN) so the decision is informed;
 *   3. a user answer ("نعم"/correction) deterministically UPGRADES the fact to
 *      user_answer/CERTAIN in session context — the confirmation loop closes
 *      without any new contract;
 *   4. private mode: appContext facts never reach the model at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import { createFiqhHaydMinimalSkill } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';

const P = 'p';
const ACTOR = 'a';
const passage = (chunkId: string): SkillKnowledgePassage => ({
  chunkId, documentId: 'doc-1', sourceId: 'src-approved-1', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 1, text: 'نص فقهي معتمد.', score: 0.5,
});

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
    async save(s: ConversationSession) { rows.set(s.id, s); return s; },
  };
}

/** Scripted model: captures prompts so tests can assert exactly what the Mind saw. */
function scriptedModel(script: (prompt: string, callOfTurn: number) => string) {
  const prompts: string[] = [];
  let turnCalls = 0;
  return {
    prompts,
    async generateText(input: { message?: string }) {
      const prompt = String(input.message ?? '');
      const firstOfTurn = !prompt.includes('طلبك:');
      if (firstOfTurn) turnCalls = 0;
      turnCalls += 1;
      prompts.push(prompt);
      return { text: script(prompt, turnCalls), model: 'scripted' };
    },
  };
}

const tool = (q: string) => JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query: q });
const answer = (text: string) => JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: text, evidenceRefs: ['chunk-a'] });
const ask = (q: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q });
const askYesNo = (q: string, factKey?: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q, yesNo: true, ...(factKey ? { factKey } : {}) });

function svc(store: ReturnType<typeof fakeStore>, model: ReturnType<typeof scriptedModel>, mode: 'contextual' | 'private' = 'contextual') {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  return new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR', dialogueAct: 'QUESTION', language: 'ar', issues: [text],
        references: { resolved: true }, corrections: [], candidates: [], facts: [],
        ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async ({ payload }) => {
        const ctx = { projectId: P, actor: ACTOR, input: payload, knowledge: {
          async search() { return [passage('chunk-a')]; },
          async resolveSources(t: string[]) { return t.includes(APPROVED_SOURCE_TITLES[0]) ? [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }] : []; },
          async adjacent() { return []; },
        }, model } as unknown as SkillExecutionContext;
        const out = (await skill.execute(ctx)) as Record<string, any>;
        return {
          status: 'completed', skillId: skill.id, skillVersion: skill.version, runId: 'r',
          ...(out.readiness ? { readiness: out.readiness } : {}),
          ...(out.answer ? { answer: out.answer } : {}),
          ...(out.trace ? { trace: out.trace } : {}),
        } as never;
      },
    },
    defaultSkillId: skill.id,
  });
}

test('4C/A: missing material fact → ASK_USER (needs_information), no ruling', async () => {
  const store = fakeStore();
  const model = scriptedModel(() => ask('جم يوم استمر الطهر قبل ما يرجع الدم؟'));
  const c = svc(store, model);
  const s = await c.create(P, ACTOR, 'contextual');
  const t = await c.handleMessage(P, ACTOR, s.id, { text: 'رجع علي دم بعد طهر', skillId: 'naqaa.fiqh-hayd-minimal' });
  assert.equal(t.status, 'needs_information');
  assert.equal(t.answer, undefined, 'no ruling when asking');
  assert.ok(t.interaction?.question.includes('؟'));
});

test('4C/B: evidence/UNCERTAIN material fact is visible to the model with its tag → confirmation question allowed', async () => {
  const store = fakeStore();
  const model = scriptedModel(() => ask('حسب معلوماتج، بداية الدم كانت أمس. صحيح؟'));
  const c = svc(store, model);
  const s = await c.create(P, ACTOR, 'contextual');
  const t = await c.handleMessage(P, ACTOR, s.id, {
    text: 'نزل علي دم اليوم، ما الحكم؟',
    skillId: 'naqaa.fiqh-hayd-minimal',
    // Stage 2 bridge: app-supplied context arrives as evidence/UNCERTAIN
    appContext: { last_bleeding_start: 'أمس' },
  });
  assert.equal(t.status, 'needs_information');
  const prompt = model.prompts[0];
  // the tag travels: the model can SEE the fact is unconfirmed app context
  assert.ok(prompt.includes('last_bleeding_start'), 'the fact reaches the model');
  assert.ok(prompt.includes('evidence/UNCERTAIN'), 'unconfirmed provenance tag is visible');
  // and the confirmation contract is in the same prompt
  assert.ok(prompt.includes('تأكيد حقيقة مادية'), 'confirmation contract present');
  assert.ok(prompt.includes('فلا تصدري ANSWER قبل تأكيدها'), 'direct-dependency rule: confirm before ruling');
});

test('4C/C+D: a yes/no confirmation binds CERTAIN; the confirmed tag replaces the unconfirmed one', async () => {
  const store = fakeStore();
  // Turn 1: model asks for confirmation of the app-context fact (yes/no confirmation).
  const model = scriptedModel((prompt) => {
    // mirror real behavior: ask while the fact is unconfirmed; once the user's 'نعم'
    // is in the recent turns, the Mind treats it as confirmed and rules.
    if (/المستخدمة: نعم/.test(prompt)) return answer('تم — الحقيقة مؤكدة الآن والحكم جاهز.');
    return askYesNo('حسب معلوماتج، بداية الدم كانت أمس. صحيح؟', 'last_bleeding_start');
  });
  const c = svc(store, model);
  const s = await c.create(P, ACTOR, 'contextual');
  const t1 = await c.handleMessage(P, ACTOR, s.id, {
    text: 'نزل علي دم اليوم',
    skillId: 'naqaa.fiqh-hayd-minimal',
    appContext: { last_bleeding_start: 'أمس' },
  });
  assert.equal(t1.status, 'needs_information');
  // the confirmation question is typed yes/no so the answer can bind CERTAIN
  assert.equal(t1.interaction?.type, 'yes_no');
  assert.deepEqual(t1.interaction?.options, ['نعم', 'لا', 'غير متأكدة']);

  // Turn 2: the user confirms ("نعم") → the conversation layer binds it as a CERTAIN
  // user_answer (the yes_no contract was persisted with the pending question).
  const t2 = await c.handleMessage(P, ACTOR, s.id, { text: 'نعم', skillId: 'naqaa.fiqh-hayd-minimal' });
  assert.equal(t2.status, 'completed');

  // Deterministic proof: the answer bound as CERTAIN user_answer (loop closes).
  const sess = store.rows.get(s.id)!;
  const meta = sess.sessionContext.factMeta ?? {};
  const confirmedKey = Object.keys(meta).find((k) => meta[k]?.provenance === 'user_answer' && meta[k]?.certainty === 'CERTAIN');
  assert.ok(confirmedKey, 'a fact was upgraded to user_answer/CERTAIN');
  assert.equal(sess.sessionContext.pendingKey, undefined, 'pending question consumed');

  // Turn 3: the model no longer sees the fact tagged as unconfirmed app context.
  const model2 = scriptedModel((_p, callOfTurn) => (callOfTurn === 1 ? tool('أكثر مدة الحيض') : answer('الحكم النهائي.')));
  const c2 = svc(store, model2);
  const t3 = await c2.handleMessage(P, ACTOR, s.id, { text: 'طيب كم أصلي؟', skillId: 'naqaa.fiqh-hayd-minimal' });
  assert.equal(t3.status, 'completed');
  const prompt3 = model2.prompts[0];
  // the known-facts block must present the fact with the CONFIRMED tag, not the app one
  assert.ok(!/last_bleeding_start = .+\(UNCERTAIN\/evidence\)/.test(prompt3), 'confirmed fact no longer tagged evidence/UNCERTAIN');
  assert.ok(/last_bleeding_start = .+\(CERTAIN\/user_answer\)/.test(prompt3), 'confirmed tag is what the model now sees');
});

test('4C/E: the confirmation contract bounds confirmation to material facts (one per turn, never secondary)', async () => {
  const store = fakeStore();
  const model = scriptedModel(() => ask('حسب معلوماتج، بداية الدم كانت أمس. صحيح؟'));
  const c = svc(store, model);
  const s = await c.create(P, ACTOR, 'contextual');
  await c.handleMessage(P, ACTOR, s.id, {
    text: 'نزل علي دم',
    skillId: 'naqaa.fiqh-hayd-minimal',
    appContext: { last_bleeding_start: 'أمس', madhab: 'الشافعي', theme_preference: 'dark' },
  });
  const prompt = model.prompts[0];
  // structural bound: one fact per turn, secondary facts excluded
  assert.ok(prompt.includes('لا تؤكدي أكثر من حقيقة واحدة في الجولة الواحدة'), 'one-fact bound instructed');
  assert.ok(prompt.includes('لا تؤكدي معلومات ثانوية أو مساندة لا يتوقف عليها الحكم'), 'secondary facts excluded');
  assert.ok(prompt.includes('فلا تصدري ANSWER قبل تأكيدها'), 'mandatory only for ruling-critical unconfirmed facts');
});

test('4C/F: sufficient + reliable info → normal ANSWER flow unchanged', async () => {
  const store = fakeStore();
  const model = scriptedModel((_p, callOfTurn) => (callOfTurn === 1 ? tool('أكثر مدة الحيض') : answer('الـ12 يوم كلها حيض. اغتسلي وصلي.')));
  const c = svc(store, model);
  const s = await c.create(P, ACTOR, 'contextual');
  const t = await c.handleMessage(P, ACTOR, s.id, { text: 'عادتي 6 أيام ورأيت دماً 12 يوماً', skillId: 'naqaa.fiqh-hayd-minimal' });
  assert.equal(t.status, 'completed');
  assert.match(t.message, /حيض/);
  assert.equal(t.interaction, undefined, 'no question injected when the model rules');
});

test('4C/G: private mode — appContext facts never reach the model (privacy unchanged)', async () => {
  const store = fakeStore();
  const model = scriptedModel(() => answer('جواب خاص.'));
  const c = svc(store, model, 'private');
  const s = await c.create(P, ACTOR, 'private');
  const t = await c.handleMessage(P, ACTOR, s.id, {
    text: 'ما الحكم؟',
    skillId: 'naqaa.fiqh-hayd-minimal',
    appContext: { last_bleeding_start: 'أمس', date_of_birth: '2001-01-10' },
  });
  assert.equal(t.status, 'completed');
  const prompt = model.prompts[0];
  assert.ok(!/last_bleeding_start = /.test(prompt), 'appContext fact absent in private');
  assert.ok(!/date_of_birth = /.test(prompt), 'personal context absent in private');
  assert.ok(!/\(UNCERTAIN\/evidence\)/.test(prompt), 'no app-context provenance tags leak in private');
});
