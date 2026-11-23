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
import type { DecisionRequirement } from '../src/core/readiness/readiness.ts';

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

/** These continuity fixtures start with an already-confirmed material fact. */
function confirmedFact(store: ReturnType<typeof fakeStore>, session: ConversationSession, key: string, value: unknown) {
  const stored = store.rows.get(session.id)!;
  stored.sessionContext.facts[key] = value;
  stored.sessionContext.factMeta = { ...stored.sessionContext.factMeta,
    [key]: { certainty: 'CERTAIN', provenance: 'user_answer', at: session.updatedAt },
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
const answerTerminal = (msg: string, summary: string, label = 'hayd', materialFactKey = 'bleeding_days') =>
  JSON.stringify({
    action: 'TERMINAL',
    status: 'ANSWER',
    message: msg,
    summary,
    evidenceRefs: ['chunk-1'],
    label,
    materialFactKeys: [materialFactKey],
  });

function makeScriptedModel() {
  const prompts: string[] = [];
  return {
    prompts,
    async generateText(input: { instructions?: string; message?: string }) {
      const prompt = [input.instructions, input.message].filter(Boolean).join('\n\n');
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
            'hayd', 'discharge_colour'
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
            'istihada', 'reported_state'
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
          factKey: 'habit_duration',
          answerType: 'duration',
        }),
        model: 'test',
      };
    },
  };
}

function createTestHarness(
  store: ReturnType<typeof fakeStore>,
  model: ReturnType<typeof makeScriptedModel>,
  memory?: { fetchBounded(projectId: string, ids: { subjectId?: string }): Promise<unknown> },
) {
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
    ...(memory ? { memory: memory as never } : {}),
    defaultSkillId: skill.id,
  });
  return { svc, skill };
}

test('Test A — direct follow-up: "ما أدري" completes the case rather than repeating question', async () => {
  const store = fakeStore();
  const model = makeScriptedModel();
  const { svc } = createTestHarness(store, model);
  const s = await svc.create('proj-1', 'user-1', 'contextual');
  confirmedFact(store, s, 'bleeding_days', 3);

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
  confirmedFact(store, s, 'bleeding_days', 3);

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
  confirmedFact(store, s, 'reported_state', 'istihada');

  // Q1
  const t1 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'هل يجوز لي الصلاة وأنا في حالة استحاضة مستمرة؟' });
  assert.equal(t1.status, 'completed');
  assert.match(t1.message, /المستحاضة تتوضأ/);

  // Q2
  confirmedFact(store, s, 'discharge_colour', 'red');
  const t2 = await svc.handleMessage('proj-1', 'user-1', s.id, { text: 'لو رأيت سائل شفاف مع لمعة حمراء اليوم هل هذا حيض؟' });
  assert.equal(t2.status, 'completed');
  assert.match(t2.message, /اللمعة الحمراء|السائل الشفاف/);
  assert.doesNotMatch(t2.message, /المستحاضة تتوضأ لكل فريضة/);
});

test('Test D — private continuity: Turn 2 understands Turn 1, zero personal context/memory', async () => {
  const store = fakeStore();
  const model = makeScriptedModel();
  const memoryCalls: string[] = [];
  const memory = new Proxy({
    async fetchBounded() {
      return {
        user: [{ id: 'private-memory', scope: 'user', memoryType: 'case', memoryKey: 'private_note', payload: { value: 'memory_leak' } }],
        conversation: [],
        case: [],
      };
    },
  }, {
    get(target, property, receiver) {
      memoryCalls.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  const { svc } = createTestHarness(store, model, memory);
  const s = await svc.create('proj-1', 'user-1', 'private');
  confirmedFact(store, s, 'bleeding_days', 3);
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

  // Verify no personal memory or appContext reaches ANY model call on either turn.
  // Looking only at the final prompt would miss an ephemeral leak in an earlier call.
  assert.ok(model.prompts.length > 0, 'the fixture must exercise the model boundary');
  const forbiddenPromptContent = [
    'duration_hours',
    'current_state',
    'calendar_entry',
    'private_leak',
    'private_note',
    'memory_leak',
  ];
  for (const [promptIndex, prompt] of model.prompts.entries()) {
    for (const forbidden of forbiddenPromptContent) {
      assert.equal(
        prompt.includes(forbidden),
        false,
        `private prompt ${promptIndex + 1} must not contain ${forbidden}`,
      );
    }
  }
  assert.deepEqual(memoryCalls, [], 'private continuity must not touch any personal Memory method');
});

test('Test D2 — corrected session fact outranks older Memory and is not asked again', async () => {
  const store = fakeStore();
  const requirements: DecisionRequirement[] = [
    {
      key: 'event_date',
      description: 'Current event date',
      material: true,
      question: { key: 'event_date', wording: 'What is the event date?' },
      interaction: { type: 'date' },
    },
    {
      key: 'duration_days',
      description: 'Current duration',
      material: true,
      question: { key: 'duration_days', wording: 'How many days?' },
      interaction: { type: 'duration' },
    },
  ];
  const seenContexts: Array<Record<string, unknown>> = [];
  const svc = new ConversationService({
    persistence: store,
    understanding: {
      evaluate: async ({ text }) => ({
        status: 'CLEAR',
        dialogueAct: 'CORRECTION',
        language: 'en',
        issues: [text],
        references: { resolved: true },
        corrections: [{ target: 'event_date', new: '2026-11-02' }],
        candidates: [],
        facts: [],
        ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      }),
    },
    memory: {
      fetchBounded: async () => ({
        user: [{ id: 'old-date', scope: 'user', memoryType: 'case', memoryKey: 'event_date', payload: { value: '2026-01-01' } }],
        conversation: [],
        case: [],
      }),
    },
    skills: {
      execute: async ({ payload }) => {
        const context = ((payload as Record<string, unknown>).context ?? {}) as Record<string, unknown>;
        seenContexts.push({ ...context });
        const known = Object.entries(context).map(([key, value]) => ({ key, value, source: 'user' as const }));
        const result = new DecisionReadinessService().evaluate({ requirements, known });
        return {
          status: result.status === 'READY_FOR_DECISION' ? 'completed' : 'needs_information',
          skillId: 'test.current-context',
          skillVersion: 1,
          runId: 'run-current-context',
          readiness: result,
        } as never;
      },
    },
    defaultSkillId: 'test.current-context',
    interactionsFor: () => ({ event_date: { type: 'date' }, duration_days: { type: 'duration' } }),
  });

  const session = await svc.create('proj-1', 'user-1', 'contextual');
  await svc.handleMessage('proj-1', 'user-1', session.id, {
    text: '2026-11-01', answers: [{ key: 'event_date', value: '2026-11-01' }],
  });

  const response = await svc.handleMessage('proj-1', 'user-1', session.id, { text: 'I meant 2026-11-02' });

  assert.equal(store.rows.get(session.id)!.sessionContext.facts.event_date, '2026-11-02');
  assert.equal(seenContexts.at(-1)?.event_date, '2026-11-02', 'the skill receives the corrected current fact');
  assert.notEqual(seenContexts.at(-1)?.event_date, '2026-01-01', 'older Memory cannot replace session truth');
  assert.equal(response.readiness?.missingKeys?.includes('event_date'), false, 'the corrected fact is not asked again');
  assert.equal(response.interaction?.key, 'duration_days', 'only the remaining material gap is asked');
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
