/**
 * STAGE 4A: CONVERSATION CONTEXT REGRESSION SUITE
 *
 * Verifies that the Naqaa fiqh assistant (Minimal Mind) reliably preserves
 * conversational context across real multi-turn flows:
 *   - Test A: Direct follow-up ("ما أدري" completes the case rather than repeating the question)
 *   - Test B: Pronoun/reference ("طيب إذا استمر؟" resolves reference from conversation context)
 *   - Test C: Topic change (new question answered, not old question repeated)
 *   - Test D: Private continuity (Turn 2 understands Turn 1, with zero personal context/memory leakage)
 *   - Test E: New conversation isolation (fresh conversation starts empty, no history leakage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import type { ConversationSession } from '../src/core/conversation/conversation.ts';
import { createFiqhHaydMinimalSkill } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';

function fakeStore() {
  const rows = new Map<string, ConversationSession>();
  return {
    rows,
    async create(s: ConversationSession) { rows.set(s.id, JSON.parse(JSON.stringify(s))); return s; },
    async get(p: string, a: string, id: string) {
      const s = rows.get(id);
      return s && s.projectId === p && s.actorSubject === a ? JSON.parse(JSON.stringify(s)) : null;
    },
    async save(s: ConversationSession) { rows.set(s.id, JSON.parse(JSON.stringify(s))); return s; },
  };
}

const passage = (chunkId: string): SkillKnowledgePassage => ({
  chunkId,
  documentId: 'doc-1',
  sourceId: 'src-approved-1',
  sourceTitle: APPROVED_SOURCE_TITLES[0],
  chunkIndex: 1,
  text: 'أقل الحيض يوم وليلة، أي أربع وعشرون ساعة، وأكثره خمسة عشر يوماً بلياليها. فإذا جاوز خمسة عشر يوماً فهو استحاضة. والمبتدأة التي لا تعرف عادتها تعتبر حائضاً إذا كان الدم بين أقله وأكثره.',
  score: 0.8,
});

function knowledge() {
  return {
    async search() { return [passage('chunk-1')]; },
    async resolveSources(titles: string[]) {
      return titles.includes(APPROVED_SOURCE_TITLES[0]) ? [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }] : [];
    },
    async adjacent() { return []; },
  };
}

const tool = (query: string) => JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query });
const answerTerminal = (msg: string, summary: string, label = 'hayd') =>
  JSON.stringify({
    action: 'TERMINAL',
    status: 'ANSWER',
    message: msg,
    summary,
    evidenceRefs: ['chunk-1'],
    label,
  });

function makeScriptedModel() {
  const prompts: string[] = [];
  return {
    prompts,
    async generateText(input: { message?: string }) {
      const prompt = String(input.message ?? '');
      prompts.push(prompt);
      const isToolTurn = prompt.includes('طلبك:');

      // Slice out the actual conversation transcript (ignoring the instructions which also mention keywords)
      const idx = prompt.lastIndexOf('\nالمحادثة:\n');
      const convo = idx >= 0 ? prompt.slice(idx + '\nالمحادثة:\n'.length) : '';
      const lastUserLine = convo.trim().split('\n').filter((l) => l.startsWith('المستخدمة')).pop() ?? '';

      // Test B: Pronoun/reference "طيب إذا استمر؟"
      if (/استمر/.test(lastUserLine)) {
        if (!isToolTurn) return { text: tool('إذا استمر دم الحيض وتجاوز أكثر الحيض'), model: 'test' };
        assert.ok(convo.includes('ينزل علي دم'), 'Test B: history contains initial bleeding context');
        assert.ok(convo.includes('طيب إذا استمر؟'), 'Test B: history contains follow-up');
        return {
          text: answerTerminal(
            'إذا استمر الدم وتجاوز 15 يوماً، فما زاد عن 15 يوماً يكون استحاضة وتصلين فيه.',
            'ما زاد عن 15 يوماً استحاضة',
            'istihada'
          ),
          model: 'test',
        };
      }

      // Test A: Follow up with "ما أدري"
      if (/ما أدري/.test(lastUserLine)) {
        if (!isToolTurn) return { text: tool('حكم من لا تعرف عادتها ونزل دم ثلاثة أيام'), model: 'test' };
        assert.ok(convo.includes('ينزل علي دم من ثلاثة أيام'), 'Test A: history contains initial bleeding statement');
        assert.ok(convo.includes('كم مدة دورتك المعتادة'), 'Test A: history contains assistant question');
        assert.ok(convo.includes('ما أدري'), 'Test A: history contains user clarification');
        assert.ok(!prompt.includes('minimal_followup'), 'Test A: minimal_followup technical key is not leaked');
        return {
          text: answerTerminal(
            'بما أنك لا تعرفين عادتك والدم نزل ثلاثة أيام، فهذا يُعد حيضاً لأنه تجاوز أقل الحيض (24 ساعة) ولم يتجاوز أكثره.',
            'الدم حيض',
            'hayd'
          ),
          model: 'test',
        };
      }

      // Test C: Topic change Q2
      if (/سائل|لمعة|أحمر|حمراء/.test(lastUserLine)) {
        if (!isToolTurn) return { text: tool('سائل شفاف مع لمعة حمراء هل هو حيض'), model: 'test' };
        return {
          text: answerTerminal(
            'اللمعة الحمراء مع السائل الشفاف تُعتبر من ألوان الدم في زمن إمكان الحيض.',
            'السائل مع اللمعة حيض في زمن الإمكان',
            'hayd'
          ),
          model: 'test',
        };
      }

      // Q1 in Test C
      if (/استحاضة مستمرة/.test(lastUserLine)) {
        if (!isToolTurn) return { text: tool('الصلاة مع الاستحاضة المستمرة'), model: 'test' };
        return {
          text: answerTerminal(
            'المستحاضة تتوضأ لكل فريضة وتصلي وصومها صحيح.',
            'تجوز الصلاة مع الاستحاضة',
            'istihada'
          ),
          model: 'test',
        };
      }

      // Default first turn asking clarification
      return {
        text: JSON.stringify({
          action: 'TERMINAL',
          status: 'ASK_USER',
          question: 'كم مدة دورتك المعتادة عادةً؟',
        }),
        model: 'test',
      };
    },
  };
}

function createTestHarness(store: ReturnType<typeof fakeStore>, model: ReturnType<typeof makeScriptedModel>) {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  const svc = new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR',
        dialogueAct: 'QUESTION',
        language: 'ar',
        issues: [text],
        references: { resolved: true },
        corrections: [],
        candidates: [],
        facts: [],
        ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    skills: {
      execute: async ({ payload, projectId, actor }) => {
        const ctx = {
          projectId,
          actor,
          input: payload,
          knowledge: knowledge(),
          model,
        } as unknown as SkillExecutionContext;
        const out = (await skill.execute(ctx)) as Record<string, any>;
        return {
          status: 'completed',
          skillId: skill.id,
          skillVersion: skill.version,
          runId: 'run-1',
          ...(out.readiness ? { readiness: out.readiness } : {}),
          ...(out.answer ? { answer: out.answer } : {}),
          ...(out.trace ? { trace: out.trace } : {}),
        } as never;
      },
    },
    defaultSkillId: skill.id,
  });
  return { svc, skill };
}

test('Test A — direct follow-up: "ما أدري" completes the case rather than repeating question', async () => {
  const store = fakeStore();
  const model = makeScriptedModel();
  const { svc } = createTestHarness(store, model);
  const s = await svc.create('proj-1', 'user-1', 'contextual');

  // Turn 1
  const t1 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'ينزل علي دم من ثلاثة أيام' });
  assert.equal(t1.status, 'needs_information');
  assert.match(t1.message, /دورتك المعتادة/);

  // Turn 2
  const t2 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'ما أدري' });
  assert.equal(t2.status, 'completed', 'Turn 2 must complete, not re-ask');
  assert.match(t2.message, /لا تعرفين عادتك|حيض/);
  assert.equal(t2.answer?.label, 'hayd');
  assert.doesNotMatch(t2.message, /كم مدة دورتك المعتادة/, 'Must NOT repeat the question');
});

test('Test B — pronoun/reference: "طيب إذا استمر؟" resolves reference from conversation', async () => {
  const store = fakeStore();
  const model = makeScriptedModel();
  const { svc } = createTestHarness(store, model);
  const s = await svc.create('proj-1', 'user-1', 'contextual');

  await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'ينزل علي دم من ثلاثة أيام' });
  await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'ما أدري' });

  // Turn 3: "طيب إذا استمر؟"
  const t3 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'طيب إذا استمر؟' });
  assert.equal(t3.status, 'completed');
  assert.match(t3.message, /15 يوماً|استحاضة/, 'Must understand what continuing refers to');
  assert.equal(t3.answer?.label, 'istihada');
});

test('Test C — topic change: new question answered, prior istihada ruling NOT repeated', async () => {
  const store = fakeStore();
  const model = makeScriptedModel();
  const { svc } = createTestHarness(store, model);
  const s = await svc.create('proj-1', 'user-1', 'contextual');

  // Q1
  const t1 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'هل يجوز لي الصلاة وأنا في حالة استحاضة مستمرة؟' });
  assert.equal(t1.status, 'completed');
  assert.match(t1.message, /المستحاضة تتوضأ/);

  // Q2
  const t2 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'لو رأيت سائل شفاف مع لمعة حمراء اليوم هل هذا حيض؟' });
  assert.equal(t2.status, 'completed');
  assert.match(t2.message, /اللمعة الحمراء|السائل الشفاف/);
  assert.doesNotMatch(t2.message, /المستحاضة تتوضأ لكل فريضة/);
});

test('Test D — private continuity: Turn 2 understands Turn 1, zero personal context/memory', async () => {
  const store = fakeStore();
  const model = makeScriptedModel();
  const { svc } = createTestHarness(store, model);
  const s = await svc.create('proj-1', 'user-1', 'private');
  assert.equal(s.mode, 'private');

  // Turn 1 in private mode
  const t1 = await svc.handleMessage('proj-1', 'user-1', s.id, {
    text: 'ينزل علي دم من ثلاثة أيام',
    appContext: { duration_hours: 72, current_state: 'hayd', calendar_entry: 'private_leak' },
  });
  assert.equal(t1.status, 'needs_information');

  // Verify appContext was completely stripped in private mode
  const savedSession1 = store.rows.get(s.id)!;
  assert.equal(savedSession1.sessionContext.facts['duration_hours'], undefined, 'appContext duration_hours must be absent in private');
  assert.equal(savedSession1.sessionContext.facts['calendar_entry'], undefined, 'calendar_entry must be absent in private');

  // Turn 2 in private mode: conversational continuity still works
  const t2 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'ما أدري' });
  assert.equal(t2.status, 'completed');
  assert.match(t2.message, /حيض/);

  // Verify no personal memory or appContext in final prompt
  const lastPrompt = model.prompts[model.prompts.length - 1];
  assert.ok(!lastPrompt.includes('calendar_entry'), 'Calendar must be absent');
  assert.ok(!lastPrompt.includes('private_leak'), 'personal context must be absent');
});

test('Test E — new conversation isolation: does not inherit prior conversation history', async () => {
  const store = fakeStore();
  const model = makeScriptedModel();
  const { svc } = createTestHarness(store, model);

  // Conv 1
  const s1 = await svc.create('proj-1', 'user-1', 'contextual');
  await svc.handleMessage('proj-1', 'user-1', s1.id, { text: 'ينزل علي دم من ثلاثة أيام' });

  // Conv 2 (fresh)
  const s2 = await svc.create('proj-1', 'user-1', 'contextual');
  assert.notEqual(s1.id, s2.id);

  const tFresh = await svc.handleMessage('proj-1', 'user-1', s2.id, { text: 'ما حكم نزول الكدرة؟' });
  assert.equal(tFresh.status, 'needs_information');

  const s2Record = store.rows.get(s2.id)!;
  // Recent turns of s2 only has the 1 fresh turn
  assert.equal(s2Record.sessionContext.recentTurns.length, 2); // 1 user + 1 assistant
  assert.equal(s2Record.sessionContext.recentTurns[0].text, 'ما حكم نزول الكدرة؟');
  assert.ok(!JSON.stringify(s2Record.sessionContext.recentTurns).includes('ينزل علي دم من ثلاثة أيام'), 'Conv 2 must NOT inherit Conv 1 history');
});
