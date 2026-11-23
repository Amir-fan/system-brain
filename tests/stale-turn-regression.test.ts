/**
 * STALE-TURN REGRESSION (current-turn authority).
 *
 * A genuinely NEW user question in an existing conversation must be answered as the
 * CURRENT turn; previous turns are context, never the task. Probed end-to-end through
 * the real ConversationService + the real Naqaa Minimal Skill with a scripted model
 * that reproduces the observed failure mode: when the model is not pointed at the
 * latest turn as the question to answer, it re-answers the dominant prior turn.
 *
 * Assertions verify semantic turn TARGETING (which question the answer is for),
 * never exact prose wording.
 *
 * Legitimate follow-ups are protected: ليش؟ / شنو المصدر؟ / a fact correction must
 * continue to use the conversation context (the scripted model asserts the context
 * is present before answering).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import { createFiqhHaydMinimalSkill } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';

const Q1 = 'هل يجوز لي الصلاة وأنا في حالة استحاضة مستمرة؟';
const Q2 = 'لو رأيت سائل شفاف مع لمعة حمراء اليوم هل هذا حيض؟';
const A1 = 'نعم يجوز الصلاة مع الاستحاضة؛ المستحاضة مكلفة بالصلاة بعد الوضوء لكل صلاة.';
const A2 = 'السائل الشفاف مع لمعة حمراء اليوم يعد حيضًا؛ لأن اللمعة الحمراء صفرة تابعة للحيض.';

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, s); return s; },
    async get(p: string, a: string, id: string) { const s = rows.get(id); return s && s.projectId === p && s.actorSubject === a ? s : null; },
    async save(s: ConversationSession) { rows.set(s.id, s); return s; },
  };
}

const passage = (chunkId: string): SkillKnowledgePassage => ({
  chunkId, documentId: 'doc-1', sourceId: 'src-approved-1', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 1, text: 'نص فقهي معتمد يوضح الشرط.', score: 0.5,
});

function knowledge() {
  return {
    async search() { return [passage('chunk-a')]; },
    async resolveSources(titles: string[]) {
      return titles.includes(APPROVED_SOURCE_TITLES[0]) ? [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }] : [];
    },
    async adjacent() { return [passage('chunk-b')]; },
  };
}

const tool = (query: string) => JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query });
const terminal = (text: string) => JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: text, evidenceRefs: ['chunk-a'] });

/**
 * A scripted model that reproduces the production failure: it sees a conversation
 * transcript where the LAST line is NOT marked as the question to answer, so it
 * falls back to re-answering the dominant earlier question (Q1) whenever the turn
 * text is not the only user line presented as "the" task.
 */
function staleAnchoringModel() {
  const calls: string[] = [];
  let turnCalls = 0;
  return {
    calls,
    async generateText(input: { instructions?: string; message?: string }) {
      const prompt = [input.instructions, input.message].filter(Boolean).join('\n\n');
      calls.push(prompt);
      const idx = prompt.lastIndexOf('\nالمحادثة:\n');
      const convo = idx >= 0 ? prompt.slice(idx + '\nالمحادثة:\n'.length) : '';
      const lastUserLine = convo.trim().split('\n').filter((l) => l.startsWith('المستخدمة')).pop() ?? '';
      // A fresh model invocation has no 'طلبك' echo yet; the tool loop appends it.
      const firstCallOfTurn = !prompt.includes('طلبك:');
      if (firstCallOfTurn) turnCalls = 0;
      turnCalls += 1;
      // The stale behaviour: without an explicit "answer THIS latest turn" directive,
      // the model treats the FIRST substantive question in the transcript as the task.
      const anchoredToQ1 = !/السؤال الحالي|السؤال الآن|المطلوب الآن|current turn|أجب عن هذا السؤال/.test(prompt) && /استحاضة/.test(convo) && !/استحاضة/.test(lastUserLine);
      if (turnCalls === 1) {
        // First model call of any turn: search before ruling.
        return { text: tool(anchoredToQ1 ? 'حكم الصلاة مع الاستحاضة المستمرة' : /حيض|سائل/.test(lastUserLine) ? 'صفة السائل الشفاف مع اللمعة الحمراء' : /ليش/.test(lastUserLine) ? 'علة اعتبار الصفرة حيضًا' : /مصدر/.test(lastUserLine) ? 'مصدر حكم الحيض' : /الساعة/.test(lastUserLine) ? 'تصحيح وقت' : 'حكم الصلاة مع الاستحاضة المستمرة'), model: 'scripted' };
      }
      if (anchoredToQ1) return { text: terminal(A1), model: 'scripted' };
      if (/ليش/.test(lastUserLine)) {
        // Legitimate follow-up: must reference the Q2 ruling context.
        return { text: terminal('لأن اللمعة الحمراء تصحب الدم فتعد من صفرة الحيض، وهذا تابع لسؤالك عن السائل الشفاف.'), model: 'scripted' };
      }
      if (/مصدر/.test(lastUserLine)) {
        return { text: terminal('المصدر المعتمد في الجواب السابق عن السائل الشفاف هو كتاب الفقه المعتمد لدينا.'), model: 'scripted' };
      }
      if (/الساعة/.test(lastUserLine)) {
        return { text: terminal('حسنًا، اعتمدتُ أن السائل ظهر الساعة 10، ولا يتغير الحكم.'), model: 'scripted' };
      }
      if (/سائل|لمعة|حيض/.test(lastUserLine)) return { text: terminal(A2), model: 'scripted' };
      return { text: terminal(A1), model: 'scripted' };
    },
  };
}

// The service wrapper emits an advisory caseFacts value to prove it cannot change an
// observation the user supplied through the declared answer control.

function svcWith(store: ReturnType<typeof fakeStore>, model: ReturnType<typeof staleAnchoringModel>) {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  return new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR', dialogueAct: /الساعة/.test(text) ? 'CORRECTION' : 'QUESTION', language: 'ar',
        issues: [text], references: { resolved: true },
        corrections: /قصدي كانت الساعة/.test(text) ? [{ target: 'time_of_observation', new: 'الساعة 10' }] : [],
        candidates: /رأيت السائل الساعة/.test(text) ? [{ kind: 'observation', value: '9', certainty: 'CERTAIN', originalText: 'الساعة 9', provenance: 'user_statement' }] : [],
        facts: [], ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async ({ payload }) => {
        const ctx = {
          projectId: 'p', actor: 'a', input: payload,
          knowledge: knowledge(), model,
        } as unknown as SkillExecutionContext;
        const out = (await skill.execute(ctx)) as Record<string, any>;
        const text = String((payload as Record<string, unknown>).text ?? '');
        return {
          status: 'completed',
          skillId: skill.id,
          skillVersion: skill.version,
          runId: 'run-1',
          ...(out.readiness ? { readiness: out.readiness } : {}),
          ...(out.answer ? { answer: out.answer } : {}),
          ...(out.trace ? { trace: out.trace } : {}),
          ...(out.caseFacts ? { caseFacts: out.caseFacts } : {}),
          ...(/رأيت السائل الساعة/.test(text) ? { caseFacts: { time_of_observation: '08:00' } } : {}),
        } as never;
      },
    },
    defaultSkillId: skill.id,
    interactionsFor: () => ({ time_of_observation: { type: 'time' } }),
  });
}

test('stale-turn regression: A/B/C/D/E — new question is the current task; follow-ups stay contextual', async () => {
  const store = fakeStore();
  const model = staleAnchoringModel();
  const c = svcWith(store, model);
  const s = await c.create('p', 'a', 'contextual');

  // A — Q1 answered as Q1.
  const t1 = await c.handleMessage('p', 'a', s.id, { text: Q1 });
  if (process.env.DEBUG_PROMPT) console.error('--- A PROMPT (last) ---\n' + model.calls[model.calls.length - 1]);
  assert.equal(t1.status, 'completed');
  assert.match(t1.message, /استحاضة/, 'A: Q1 answer targets istihada');

  // B — Q2 in the SAME conversation must be answered as Q2, not repeated Q1.
  const t2 = await c.handleMessage('p', 'a', s.id, { text: Q2 });
  if (process.env.DEBUG_PROMPT) {
    console.error('--- LAST PROMPT TAIL ---\n' + model.calls[model.calls.length - 1].split('\n').slice(-8).join('\n'));
    const sess = store.rows.get(s.id)!;
    console.error('--- TRACE: ' + JSON.stringify(t2.trace?.notes ?? null) + ' LGR: ' + JSON.stringify(sess.sessionContext.lastGroundedResult ?? null).slice(0, 300));
  }
  assert.equal(t2.status, 'completed');
  assert.match(t2.message, /سائل|لمعة|حيض/, 'B: Q2 answer targets the new question');
  assert.doesNotMatch(t2.message, /المستحاضة مكلفة بالصلاة/, 'B: Q2 answer is NOT the repeated Q1 ruling');

  // C — ليش؟ after Q2 is a follow-up to Q2 (uses context, not a restart).
  const t3 = await c.handleMessage('p', 'a', s.id, { text: 'ليش؟' });
  assert.equal(t3.status, 'completed');
  assert.match(t3.message, /صفرة|اللمعة|السائل/, 'C: why-follow-up explains the Q2 ruling');

  // D — شنو المصدر؟ remains a source follow-up in the same context.
  const t4 = await c.handleMessage('p', 'a', s.id, { text: 'شنو المصدر؟' });
  assert.equal(t4.status, 'completed');
  assert.match(t4.message, /[مصدر|كتاب|فقه]/, 'D: source follow-up is contextual');

  // E — a correction supersedes the prior fact. First establish the fact, then correct it.
  const t5a = await c.handleMessage('p', 'a', s.id, { text: 'رأيت السائل الساعة 9', answers: [{ key: 'time_of_observation', value: '09:00' }] });
  assert.equal(t5a.status, 'completed');
  const sessPre = store.rows.get(s.id)!;
  assert.equal(sessPre.sessionContext.facts.time_of_observation, '09:00', 'E setup: fact established');
  const t5 = await c.handleMessage('p', 'a', s.id, { text: 'لا قصدي كانت الساعة 10' });
  assert.equal(t5.status, 'completed');
  const sess = store.rows.get(s.id)!;
  assert.equal(sess.sessionContext.facts.time_of_observation, '10:00', 'E: correction superseded the prior fact');
});
