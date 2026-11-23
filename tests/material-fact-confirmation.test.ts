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
import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { handleSkillExecute } from '../src/platform/api/skill-handler.ts';

const P = 'p';
const ACTOR = 'a';
const passage = (chunkId: string, text = 'نص فقهي معتمد.'): SkillKnowledgePassage => ({
  chunkId, documentId: 'doc-1', sourceId: 'src-approved-1', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 1, text, score: 0.5,
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
    async generateText(input: { instructions?: string; message?: string }) {
      const prompt = [input.instructions, input.message].filter(Boolean).join('\n\n');
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
const ask = (q: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q, factKey: 'requested_fact', answerType: 'free_text' });
const askYesNo = (q: string, factKey?: string) => JSON.stringify({ action: 'TERMINAL', status: 'ASK_USER', question: q, yesNo: true, answerType: 'yes_no', ...(factKey ? { factKey } : {}) });

test('admission hardening: raw skill execution accepts fact provenance only from a trusted service', async () => {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  const registry = new MapSkillRegistry();
  registry.register(skill);
  const persistence = {
    async getProject(id: string) { return { id, name: 'test', status: 'active' as const, createdAt: '', updatedAt: '' }; },
    async getMembership(projectId: string, actor: string) {
      return { projectId, actor, role: actor === 'trusted' ? 'service' as const : 'member' as const, createdAt: '' };
    },
    async createRun() {}, async updateRun() {},
  };
  let calls = 0;
  const runtime = new SkillsRuntime({
    persistence, registry,
    knowledge: () => ({
      async resolveSources() { return [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }]; },
      async search() { return [passage('chunk-a')]; }, async adjacent() { return []; },
    }),
    modelGateway: {
      async generateText({ input }) {
        if (calls++ % 2 === 0) return { text: tool('الحكم') };
        const educational = JSON.stringify(input).includes('سؤال تعليمي');
        return { text: educational ? answer('الطهر هو انقطاع الحيض.') : JSON.stringify({
          status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['onset'],
        }) };
      },
      async embedTexts() { throw new Error('unexpected embed'); },
    },
  });
  const deps = { boundary: persistence, registry, runtime };
  const payload = {
    text: 'ما الحكم؟', context: { onset: 'yesterday' },
    factMeta: { onset: { certainty: 'CERTAIN', provenance: 'user_answer' } },
  };
  const forged = await handleSkillExecute(deps, P, ACTOR, skill.id, { payload });
  assert.equal(forged.status, 403);
  assert.equal(calls, 0);
  const trusted = await handleSkillExecute(deps, P, 'trusted', skill.id, { payload });
  assert.equal(trusted.status, 200);
  assert.ok(trusted.ok);
  assert.equal((trusted.data as { answer?: { label?: string } }).answer?.label, 'hayd');
  const advisory = await handleSkillExecute(deps, P, ACTOR, skill.id, { payload: { text: payload.text, context: payload.context } });
  assert.equal(advisory.status, 200);
  assert.ok(advisory.ok);
  assert.equal((advisory.data as { answer?: { label?: string } }).answer?.label, undefined);
  const educational = await handleSkillExecute(deps, P, ACTOR, skill.id, { payload: { text: 'سؤال تعليمي' } });
  assert.equal(educational.status, 200);
  assert.ok(educational.ok);
  assert.equal((educational.data as { answer?: { text?: string } }).answer?.text, 'الطهر هو انقطاع الحيض.');
});

function svc(
  store: ReturnType<typeof fakeStore>,
  model: ReturnType<typeof scriptedModel>,
  mode: 'contextual' | 'private' = 'contextual',
  evidence = passage('chunk-a'),
  understanding: ConstructorParameters<typeof ConversationService>[0]['understanding'] = new UnderstandingService(),
) {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  return new ConversationService({
    persistence: store,
    understanding,
    skills: {
      execute: async ({ payload }) => {
        const ctx = { projectId: P, actor: ACTOR, input: payload, knowledge: {
          async search() { return [evidence]; },
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

function runtimeSvc(
  store: ReturnType<typeof fakeStore>,
  model: ReturnType<typeof scriptedModel>,
  evidence = passage('chunk-a'),
) {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  const registry = new MapSkillRegistry();
  registry.register(skill);
  const persistence = {
    async getProject(id: string) { return { id, name: 'test', status: 'active' as const, createdAt: '', updatedAt: '' }; },
    async getMembership(projectId: string, actor: string) { return { projectId, actor, role: 'member' as const, createdAt: '' }; },
    async createRun() {},
    async updateRun() {},
  };
  const runtime = new SkillsRuntime({
    persistence,
    registry,
    knowledge: () => ({
      async search() { return [evidence]; },
      async resolveSources(titles: string[]) {
        return titles.includes(APPROVED_SOURCE_TITLES[0])
          ? [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }]
          : [];
      },
      async adjacent() { return []; },
    }),
    modelGateway: {
      async generateText({ instructions, input }) {
        const request = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        return model.generateText({
          ...(instructions ? { instructions } : {}),
          ...(typeof request.message === 'string' ? { message: request.message } : {}),
        });
      },
      async embedTexts() { throw new Error('unexpected embed'); },
    },
  });
  return new ConversationService({
    persistence: store,
    understanding: new UnderstandingService(),
    skills: {
      execute: async ({ skillId, payload }) => runtime.execute({ projectId: P, actor: ACTOR, skillId, payload }),
    },
    defaultSkillId: skill.id,
  });
}

test('Minimal personal fact gate rejects CERTAIN values not admitted as user answers', async () => {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
  let calls = 0;
  const out = await skill.execute({
    projectId: P,
    actor: ACTOR,
    input: {
      text: 'ما الحكم؟',
      context: { onset: 'yesterday' },
      factMeta: { onset: { certainty: 'CERTAIN', provenance: 'user_statement' } },
    },
    knowledge: {
      async resolveSources() { return [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }]; },
      async search() { return [passage('chunk-a', 'يشترط تأكيد البداية.')]; },
      async adjacent() { return []; },
    },
    model: {
      async generateText() {
        return { text: ++calls === 1 ? tool('البداية') : JSON.stringify({
          status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['onset'],
        }) };
      },
    },
  } as SkillExecutionContext) as { answer?: { label?: string }; trace?: { status?: string } };

  assert.equal(out.answer?.label, undefined);
  assert.equal(out.trace?.status, 'INSUFFICIENT_EVIDENCE');
});

for (const key of ['output_style', 'responseStyle', 'preferred_format']) {
  test(`final fiqh fix round 1: private admitted presentation key ${key} cannot authorize Minimal`, async () => {
    const store = fakeStore();
    const model = scriptedModel((prompt, call) => {
      if (!prompt.includes(`- ${key} =`)) return JSON.stringify({
        action: 'TERMINAL', status: 'ASK_USER', question: 'ما تفضيل العرض؟', factKey: key, answerType: 'free_text',
      });
      return call === 1
        ? tool('حكم الحالة')
        : JSON.stringify({
          action: 'TERMINAL', status: 'ANSWER', message: 'هذا حيض.', label: 'hayd',
          evidenceRefs: ['chunk-a'], materialFactKeys: [key],
        });
    });
    const conversation = runtimeSvc(store, model);
    const session = await conversation.create(P, ACTOR, 'private');
    await conversation.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
    const response = await conversation.handleMessage(P, ACTOR, session.id, {
      text: 'مختصر', answers: [{ key, value: 'مختصر' }],
    });
    const context = store.rows.get(session.id)!.sessionContext;
    assert.equal(context.factMeta?.[key]?.certainty, 'CERTAIN');
    assert.equal(response.answer?.label, undefined);
    assert.equal(context.lastGroundedResult, undefined);
  });
}

test('final transition: a Runtime-backed Minimal ruling persists its validated decision label and exact proof', async () => {
  const store = fakeStore();
  const model = scriptedModel((_prompt, call) => call === 1
    ? tool('حكم البداية')
    : JSON.stringify({
        action: 'TERMINAL', status: 'ANSWER', message: 'هذا حيض.', label: 'hayd',
        evidenceRefs: ['chunk-a'], materialFactKeys: ['onset'],
      }));
  const conversation = runtimeSvc(store, model);
  const session = await conversation.create(P, ACTOR, 'private');
  const context = store.rows.get(session.id)!.sessionContext;
  context.facts.onset = 'yesterday';
  context.factMeta = { onset: { certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z' } };

  const response = await conversation.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
  assert.equal(response.trace?.decisionLabel, 'hayd');
  assert.equal(response.answer?.label, 'hayd');
  assert.deepEqual(store.rows.get(session.id)!.sessionContext.lastGroundedResult, {
    skillId: 'naqaa.fiqh-hayd-minimal', status: 'ANSWER', decision: 'hayd', explanation: 'هذا حيض.',
    sourceTitle: APPROVED_SOURCE_TITLES[0], evidenceRefs: ['chunk-a'], materialFactKeys: ['onset'],
    caseSignature: store.rows.get(session.id)!.sessionContext.lastGroundedResult?.caseSignature,
  });
});

test('final follow-up: Runtime-backed Minimal reuses source and why without a model call or stored-result rewrite', async () => {
  const store = fakeStore();
  const model = scriptedModel((_prompt, call) => call === 1
    ? tool('حكم البداية')
    : JSON.stringify({
        action: 'TERMINAL', status: 'ANSWER', message: 'هذا حيض.', label: 'hayd',
        evidenceRefs: ['chunk-a'], materialFactKeys: ['onset'],
      }));
  const conversation = runtimeSvc(store, model);
  const session = await conversation.create(P, ACTOR, 'private');
  const context = store.rows.get(session.id)!.sessionContext;
  context.facts.onset = 'yesterday';
  context.factMeta = { onset: { certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z' } };
  await conversation.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
  const original = structuredClone(store.rows.get(session.id)!.sessionContext.lastGroundedResult);
  assert.equal(model.prompts.length, 2);

  const source = await conversation.handleMessage(P, ACTOR, session.id, { text: 'شنو المصدر؟' });
  assert.equal(model.prompts.length, 2, 'source reuse must not call the model');
  assert.equal(source.trace?.status, 'FOLLOWUP_SOURCE');
  assert.equal(source.trace?.reusedGroundedResult, true);
  assert.deepEqual(source.trace?.materialFactKeys, ['onset']);
  assert.match(source.answer?.text ?? '', /المصدر المعتمد/);
  assert.deepEqual(store.rows.get(session.id)!.sessionContext.lastGroundedResult, original);

  const why = await conversation.handleMessage(P, ACTOR, session.id, { text: 'ليش؟' });
  assert.equal(model.prompts.length, 2, 'why reuse must not call the model');
  assert.equal(why.trace?.status, 'FOLLOWUP_WHY');
  assert.equal(why.answer?.text, 'هذا حيض.');
  assert.deepEqual(store.rows.get(session.id)!.sessionContext.lastGroundedResult, original);
});

test('final follow-up: Minimal refuses replay when the stored dependency is no longer confirmed', async () => {
  const store = fakeStore();
  const model = scriptedModel((_prompt, call) => call === 1
    ? tool('حكم البداية')
    : JSON.stringify({
        action: 'TERMINAL', status: 'ANSWER', message: 'هذا حيض.', label: 'hayd',
        evidenceRefs: ['chunk-a'], materialFactKeys: ['onset'],
      }));
  const conversation = runtimeSvc(store, model);
  const session = await conversation.create(P, ACTOR, 'private');
  const context = store.rows.get(session.id)!.sessionContext;
  context.facts.onset = 'yesterday';
  context.factMeta = { onset: { certainty: 'CERTAIN', provenance: 'user_answer', at: '2026-11-01T00:00:00.000Z' } };
  await conversation.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
  store.rows.get(session.id)!.sessionContext.factMeta!.onset = {
    certainty: 'UNCERTAIN', provenance: 'user_answer', at: '2026-11-02T00:00:00.000Z',
  };

  const response = await conversation.handleMessage(P, ACTOR, session.id, { text: 'ليش؟' });
  assert.ok(model.prompts.length > 2, 'invalid stored proof must fall through to the normal safe path');
  assert.notEqual(response.trace?.status, 'FOLLOWUP_WHY');
  assert.equal(store.rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
});

test('admission round 6: Conversation never forwards personal verdict text hidden in a Minimal gap status', async () => {
  const personalGap = JSON.stringify({
    action: 'TERMINAL', status: 'INSUFFICIENT_EVIDENCE', message: 'هذا حيض شخصيًا.',
    label: 'hayd', materialFactKeys: ['onset'],
  });
  const store = fakeStore();
  const c = svc(store, scriptedModel(() => personalGap), 'private');
  const session = await c.create(P, ACTOR, 'private');
  store.rows.set(session.id, { ...session, sessionContext: {
    ...session.sessionContext,
    reconfirmation: { keys: ['legacy_onset'] },
  } });

  const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
  assert.equal(turn.status, 'completed');
  assert.notEqual(turn.message, 'هذا حيض شخصيًا.');
  assert.equal(turn.answer?.label, undefined);
  assert.deepEqual(store.rows.get(session.id)!.sessionContext.reconfirmation?.keys, ['legacy_onset']);
  assert.equal(store.rows.get(session.id)!.sessionContext.lastGroundedResult, undefined);
});

test('a general question can receive a cited educational answer without a personal ruling label', async () => {
  const wording = 'الطهر هو انقطاع الحيض.';
  const evidence = passage('chunk-a', 'الطهر انقطاع الحيض.');
  const model = scriptedModel((prompt, call) => {
    if (call === 1) return tool('معنى الطهر');
    assert.ok(prompt.includes(evidence.text));
    return answer(wording);
  });
  const c = svc(fakeStore(), model, 'private', evidence);
  const session = await c.create(P, ACTOR, 'private');
  const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'سؤال عام: ما معنى الطهر؟' });
  assert.equal(turn.status, 'completed');
  assert.equal(turn.message, wording);
  assert.deepEqual(turn.answer?.evidenceIds, ['chunk-a']);
  assert.equal(turn.answer?.sourceTitle, APPROVED_SOURCE_TITLES[0]);
  assert.equal(turn.answer?.label, undefined);
  assert.equal(turn.interaction, undefined);
  assert.doesNotMatch(model.prompts[0], /label إلزامي مع كل ANSWER/);
  assert.match(model.prompts[0], /التعليمي العام[^\n]*دون label/);
});

test('Minimal rejects a cited personal proposal relying on UNCERTAIN onset in Conversation', async () => {
  const evidence = passage('chunk-a', 'لا يطبق الحكم الشخصي حتى يتأكد وقت بداية الدم.');
  const model = scriptedModel((_prompt, call) => call === 1 ? tool('وقت البداية') : JSON.stringify({
    status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'],
    materialFactKeys: ['last_bleeding_start'],
  }));
  const store = fakeStore();
  const c = svc(store, model, 'contextual', evidence);
  const session = await c.create(P, ACTOR, 'contextual');
  const turn = await c.handleMessage(P, ACTOR, session.id, {
    text: 'ما الحكم؟', appContext: { last_bleeding_start: 'أمس' },
  });
  assert.equal(turn.answer?.label, undefined);
  assert.notEqual(turn.message, 'هذا حيض.');
  assert.equal(store.rows.get(session.id)?.sessionContext.lastGroundedResult, undefined);
});

for (const [scenario, keys, certainty, value, permitted, ...provenance] of [
  ['confirmed material fact', ['onset'], 'CERTAIN', 'yesterday', true],
  ['uncertain material fact', ['onset'], 'UNCERTAIN', 'yesterday', false],
  ['unknown material fact', ['onset'], 'UNKNOWN', 'yesterday', false],
  ['missing certainty', ['onset'], undefined, 'yesterday', false],
  ['missing value', ['onset'], 'CERTAIN', undefined, false],
  ['blank value', ['onset'], 'CERTAIN', '   ', false],
  ['empty collection', ['onset'], 'CERTAIN', [], false],
  ['blank collection contents', ['onset'], 'CERTAIN', ['  '], false],
  ['unknown sentinel value', ['onset'], 'CERTAIN', 'UNKNOWN', false],
  ['unknown collection contents', ['onset'], 'CERTAIN', ['UNKNOWN'], false],
  ['stored uncertainty option', ['onset'], 'CERTAIN', ['الأول', 'غير متأكدة'], false],
  ['stored uncertainty phrase', ['onset'], 'CERTAIN', 'ما أدري', false],
  ['certain user statement', ['onset'], 'CERTAIN', 'yesterday', false, 'user_statement'],
  ['certain app evidence', ['onset'], 'CERTAIN', 'yesterday', false, 'evidence'],
  ['certain Memory', ['onset'], 'CERTAIN', 'yesterday', false, 'memory'],
  ['missing provenance', ['onset'], 'CERTAIN', 'yesterday', false, undefined],
  ['confirmed false boolean', ['onset'], 'CERTAIN', false, true],
  ['confirmed zero number', ['onset'], 'CERTAIN', 0, true],
  ['confirmed date', ['onset'], 'CERTAIN', '2026-11-02', true],
  ['undeclared dependencies', undefined, 'CERTAIN', 'yesterday', false],
  ['empty dependencies', [], 'CERTAIN', 'yesterday', false],
  ['unknown dependency', ['invented'], 'CERTAIN', 'yesterday', false],
  ['malformed dependency', ['onset', 42], 'CERTAIN', 'yesterday', false],
  ['padded dependency', [' onset '], 'CERTAIN', 'yesterday', false],
  ['duplicate dependency', ['onset', 'onset'], 'CERTAIN', 'yesterday', false],
] as const) {
  test(`Minimal personal fact gate: ${scenario}`, async () => {
    const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
    let calls = 0;
    const out = await skill.execute({
      projectId: P, actor: ACTOR,
      input: { text: 'ما الحكم؟', context: { onset: value, secondary: 'hint' }, factMeta: {
        onset: { certainty, provenance: provenance.length ? provenance[0] : 'user_answer' }, secondary: { certainty: 'UNCERTAIN', provenance: 'memory' },
      } },
      knowledge: {
        async resolveSources() { return [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }]; },
        async search() { return [passage('chunk-a', 'يشترط تأكيد البداية.')]; },
        async adjacent() { return []; },
      },
      model: { async generateText() { return { text: ++calls === 1 ? tool('البداية') : JSON.stringify({
        status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: keys,
      }) }; } },
    } as SkillExecutionContext) as { answer?: { text?: string; label?: string }; trace?: { status?: string } };
    assert.equal(out.answer?.label, permitted ? 'hayd' : undefined);
    assert.equal(out.trace?.status, permitted ? 'ANSWER' : 'INSUFFICIENT_EVIDENCE');
    if (!permitted) assert.notEqual(out.answer?.text, 'هذا حيض.');
  });
}

test('Minimal clarification binds onset and permits a personal answer on the second turn', async () => {
  const store = fakeStore();
  const model = scriptedModel((prompt, call) => {
    if (!prompt.includes('- onset =')) return JSON.stringify({
      status: 'ASK_USER', question: 'متى بدأ الدم؟', factKey: 'onset', answerType: 'date',
    });
    assert.match(prompt, /- onset = "2026-11-02" \(CERTAIN\/user_answer\)/);
    return call === 1 ? tool('بداية الدم') : JSON.stringify({
      status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['onset'],
    });
  });
  const c = svc(store, model);
  const session = await c.create(P, ACTOR, 'contextual');
  const first = await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
  assert.equal(first.status, 'needs_information');
  assert.equal(store.rows.get(session.id)?.sessionContext.pendingKey, 'onset');
  const second = await c.handleMessage(P, ACTOR, session.id, { text: '2026-11-02' });
  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(state.facts.onset, '2026-11-02');
  assert.equal(state.factMeta?.onset.certainty, 'CERTAIN');
  assert.equal(state.facts.minimal_followup, undefined);
  assert.equal(second.status, 'completed');
  assert.equal(second.answer?.label, 'hayd');
  assert.deepEqual(second.answer?.evidenceIds, ['chunk-a']);
});

test('Minimal numeric clarification binds a confirmed scalar and permits a personal answer', async () => {
  const store = fakeStore();
  const model = scriptedModel((prompt, call) => {
    if (!prompt.includes('- duration_days =')) return JSON.stringify({
      status: 'ASK_USER', question: 'كم يوم استمر الدم؟', factKey: 'duration_days', answerType: 'number',
    });
    assert.match(prompt, /- duration_days = 6 \(CERTAIN\/user_answer\)/);
    return call === 1 ? tool('مدة الدم') : JSON.stringify({
      status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['duration_days'],
    });
  });
  const c = svc(store, model);
  const session = await c.create(P, ACTOR, 'contextual');
  const first = await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
  assert.equal(first.status, 'needs_information');
  assert.equal(first.interaction?.type, 'number');
  const second = await c.handleMessage(P, ACTOR, session.id, { text: '6' });
  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(state.facts.duration_days, 6);
  assert.equal(state.factMeta?.duration_days.certainty, 'CERTAIN');
  assert.equal(second.answer?.label, 'hayd');
  assert.deepEqual(second.answer?.evidenceIds, ['chunk-a']);
});

for (const [question, answerType, directAnswer, expectedValue] of [
  ['What does purity mean?', 'free_text', '2026-11-02', '2026-11-02'],
  ['ما معنى الطهر', 'free_text', '2026-11-02', '2026-11-02'],
  ['كم يوم أحتاج بعد 6 أيام', 'number', '٦', 6],
  ['السلام عليكم، كم يوم أحتاج بعد 6 أيام', 'number', '٦', 6],
  ['أحتاج أنتظر ٦ أيام؟ 🙏', 'number', '٦', 6],
  ['‘What does purity mean?’', 'free_text', '2026-11-02', '2026-11-02'],
  ['I mean 6?', 'number', '6', 6],
  ['I mean 6?.', 'number', '٦', 6],
] as const) {
  test(`Minimal pending material fact is not answered by an unrelated question: ${question}`, async () => {
    const store = fakeStore();
    const model = scriptedModel((prompt, call) => {
      if (!prompt.includes('المساعد:')) return JSON.stringify({
        status: 'ASK_USER', question: 'ما المعلومة المطلوبة؟', factKey: 'observation', answerType,
      });
      return call === 1 ? tool('الحكم') : JSON.stringify({
        status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['observation'],
      });
    });
    const c = svc(store, model);
    const session = await c.create(P, ACTOR, 'contextual');
    assert.equal((await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' })).status, 'needs_information');
    const unrelated = await c.handleMessage(P, ACTOR, session.id, { text: question });
    const state = store.rows.get(session.id)!.sessionContext;
    assert.equal(state.facts.observation, undefined);
    assert.equal(state.factMeta?.observation, undefined);
    assert.equal(state.pendingKey, 'observation');
    assert.equal(state.pendingInteraction?.type, answerType);
    assert.equal(unrelated.understanding.dialogueAct, 'QUESTION');
    assert.equal(unrelated.answer?.label, undefined);
    const answered = await c.handleMessage(P, ACTOR, session.id, {
      text: directAnswer, answers: [{ key: 'observation', value: expectedValue }],
    });
    assert.equal(store.rows.get(session.id)!.sessionContext.facts.observation, expectedValue);
    assert.equal(answered.answer?.label, 'hayd');
  });
}

for (const [question, answerType] of [
  ['ما لون الدم', 'free_text'],
  ['السلام عليكم كم يوم أحتاج بعد 6 أيام', 'number'],
  ['Could I wait 6 days', 'number'],
] as const) {
  test(`contract admission ignores a compatible value inside an unlisted question: ${question}`, async () => {
    const store = fakeStore();
    const model = scriptedModel((prompt, call) => {
      if (!prompt.includes('المساعد:')) return JSON.stringify({
        status: 'ASK_USER', question: 'ما المعلومة المطلوبة؟', factKey: 'observation', answerType,
      });
      return call === 1 ? tool('الحكم') : JSON.stringify({
        status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['observation'],
      });
    });
    const c = svc(store, model);
    const session = await c.create(P, ACTOR, 'contextual');
    assert.equal((await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' })).status, 'needs_information');

    const turn = await c.handleMessage(P, ACTOR, session.id, { text: question });
    const state = store.rows.get(session.id)!.sessionContext;
    assert.equal(state.facts.observation, undefined);
    assert.equal(state.factMeta?.observation, undefined);
    assert.equal(state.pendingKey, 'observation');
    assert.equal(turn.answer?.label, undefined);
  });
}

test('contract admission is safe even when Understanding misclassifies a scalar question as a statement', async () => {
  const store = fakeStore();
  const model = scriptedModel((prompt, call) => {
    if (!prompt.includes('المساعد:')) return JSON.stringify({
      status: 'ASK_USER', question: 'كم يوم؟', factKey: 'duration_days', answerType: 'number',
    });
    return call === 1 ? tool('الحكم') : JSON.stringify({
      status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['duration_days'],
    });
  });
  const misclassifyingUnderstanding: ConstructorParameters<typeof ConversationService>[0]['understanding'] = {
    async evaluate({ text }) {
      return {
        status: 'CLEAR', dialogueAct: 'STATEMENT', language: 'en', issues: [text],
        references: { resolved: true }, corrections: [], facts: [], candidates: [{
          kind: 'duration', value: 6, unit: 'day', originalText: '6 days', certainty: 'CERTAIN', provenance: 'user_statement',
        }],
        ambiguity: { material: false },
        contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] },
      };
    },
  };
  const c = svc(store, model, 'contextual', passage('chunk-a'), misclassifyingUnderstanding);
  const session = await c.create(P, ACTOR, 'contextual');
  await c.handleMessage(P, ACTOR, session.id, { text: 'start' });

  const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'Could I wait 6 days' });
  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(state.facts.duration_days, undefined);
  assert.equal(state.factMeta?.duration_days, undefined);
  assert.equal(turn.answer?.label, undefined);
});

for (const confirmation of ['أي نعم', 'إي نعم'] as const) {
  test(`a pending yes/no contract accepts the Gulf Arabic confirmation ${confirmation}`, async () => {
    const store = fakeStore();
    const model = scriptedModel((prompt, call) => {
      if (!prompt.includes('- bleeding_stopped =')) return JSON.stringify({
        status: 'ASK_USER', question: 'هل توقف الدم؟', factKey: 'bleeding_stopped', yesNo: true, answerType: 'yes_no',
      });
      return call === 1 ? tool('الحكم') : JSON.stringify({
        status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['bleeding_stopped'],
      });
    });
    const c = svc(store, model);
    const session = await c.create(P, ACTOR, 'contextual');
    await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });

    const turn = await c.handleMessage(P, ACTOR, session.id, { text: confirmation });
    const state = store.rows.get(session.id)!.sessionContext;
    assert.equal(state.facts.bleeding_stopped, true);
    assert.equal(state.factMeta?.bleeding_stopped?.certainty, 'CERTAIN');
    assert.equal(state.factMeta?.bleeding_stopped?.provenance, 'user_answer');
    assert.equal(turn.answer?.label, 'hayd');
  });
}

test('raw free text cannot become a confirmed material fact without a structured answer', async () => {
  const store = fakeStore();
  const model = scriptedModel((prompt, call) => {
    if (!prompt.includes('المساعد:')) return JSON.stringify({
      status: 'ASK_USER', question: 'صفي ما حدث.', factKey: 'observation', answerType: 'free_text',
    });
    return call === 1 ? tool('الحكم') : JSON.stringify({
      status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['observation'],
    });
  });
  const c = svc(store, model);
  const session = await c.create(P, ACTOR, 'contextual');
  await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });

  const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'ما نزل دم' });
  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(state.facts.observation, undefined);
  assert.equal(state.factMeta?.observation, undefined);
  assert.equal(turn.answer?.label, undefined);
});

test('structured free text is explicit intent and may confirm the active material fact', async () => {
  const store = fakeStore();
  const model = scriptedModel((prompt, call) => {
    if (!prompt.includes('- observation =')) return JSON.stringify({
      status: 'ASK_USER', question: 'صفي ما حدث.', factKey: 'observation', answerType: 'free_text',
    });
    return call === 1 ? tool('الحكم') : JSON.stringify({
      status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['observation'],
    });
  });
  const c = svc(store, model);
  const session = await c.create(P, ACTOR, 'contextual');
  await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });

  const turn = await c.handleMessage(P, ACTOR, session.id, {
    text: 'ما نزل دم', answers: [{ key: 'observation', value: 'ما نزل دم' }],
  });
  const state = store.rows.get(session.id)!.sessionContext;
  assert.equal(state.facts.observation, 'ما نزل دم');
  assert.equal(state.factMeta?.observation?.certainty, 'CERTAIN');
  assert.equal(state.factMeta?.observation?.provenance, 'user_answer');
  assert.equal(turn.answer?.label, 'hayd');
});

for (const [answerType, reply, expectedValue] of [
  ['free_text', 'ما نزل دم', 'ما نزل دم'],
  ['duration', 'ما نزل دم لمدة ٦ أيام', '٦ أيام'],
] as const) {
  test(`Minimal pending ${answerType} accepts an explicit structured Arabic negative reply`, async () => {
    const store = fakeStore();
    const model = scriptedModel((prompt, call) => {
      if (!prompt.includes('- observation =')) return JSON.stringify({
        status: 'ASK_USER', question: 'ما المعلومة المطلوبة؟', factKey: 'observation', answerType,
      });
      return call === 1 ? tool('الحكم') : JSON.stringify({
        status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['observation'],
      });
    });
    const c = svc(store, model);
    const session = await c.create(P, ACTOR, 'contextual');
    assert.equal((await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' })).status, 'needs_information');
    const answered = await c.handleMessage(P, ACTOR, session.id, {
      text: reply, answers: [{ key: 'observation', value: expectedValue }],
    });
    const state = store.rows.get(session.id)!.sessionContext;
    assert.equal(answered.understanding.dialogueAct, 'STATEMENT');
    assert.equal(state.facts.observation, expectedValue);
    assert.equal(state.factMeta?.observation?.certainty, 'CERTAIN');
    assert.equal(answered.answer?.label, 'hayd');
  });
}

for (const [scenario, type, value, expectedValue, certainty, expectedLabel] of [
  ['mixed selections', 'multiple_choice', ['الأول', 'غير متأكدة'], 'UNKNOWN', 'UNKNOWN', undefined],
  ['uncertainty only', 'multiple_choice', ['غير متأكدة'], 'UNKNOWN', 'UNKNOWN', undefined],
  ['all real selections', 'multiple_choice', ['الأول', 'الثاني'], ['الأول', 'الثاني'], 'CERTAIN', 'hayd'],
  ['single selection', 'single_choice', 'الأول', 'الأول', 'CERTAIN', 'hayd'],
] as const) {
  test(`Minimal structured material answer: ${scenario}`, async () => {
    const store = fakeStore();
    const model = scriptedModel((prompt, call) => {
      if (!prompt.includes('المساعد:')) return JSON.stringify({
        status: 'ASK_USER', question: 'أي وصف ينطبق؟', factKey: 'observation', answerType: type, options: ['الأول', 'الثاني'],
      });
      return call === 1 ? tool('الحكم') : JSON.stringify({
        status: 'ANSWER', message: 'هذا حيض.', label: 'hayd', evidenceRefs: ['chunk-a'], materialFactKeys: ['observation'],
      });
    });
    const c = svc(store, model);
    const session = await c.create(P, ACTOR, 'contextual');
    const first = await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
    assert.equal(first.interaction?.key, 'observation');
    assert.equal(first.interaction?.type, type);
    assert.deepEqual(first.interaction?.options, ['الأول', 'الثاني', 'غير متأكدة']);
    const answered = await c.handleMessage(P, ACTOR, session.id, {
      text: 'ما معنى الطهر؟', answers: [{ key: 'observation', value }],
    });
    const state = store.rows.get(session.id)!.sessionContext;
    assert.deepEqual(state.facts.observation, expectedValue);
    assert.equal(state.factMeta?.observation?.certainty, certainty);
    assert.equal(answered.answer?.label, expectedLabel);
  });
}

for (const answerType of [undefined, '', 'numeric', 42, { type: 'number' }, ['number']]) {
  test(`Minimal rejects a material question with invalid answer type ${JSON.stringify(answerType)}`, async () => {
    const store = fakeStore();
    const c = svc(store, scriptedModel(() => JSON.stringify({
      status: 'ASK_USER', question: 'كم يوم؟', factKey: 'duration_days', answerType,
    })));
    const session = await c.create(P, ACTOR, 'contextual');
    const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
    assert.equal(turn.interaction, undefined);
    assert.equal(store.rows.get(session.id)?.sessionContext.pendingKey, undefined);
  });
}

test('Minimal rejects a categorical material question without choices', async () => {
  const store = fakeStore();
  const c = svc(store, scriptedModel(() => JSON.stringify({
    status: 'ASK_USER', question: 'ما اللون؟', factKey: 'colour', answerType: 'single_choice',
  })));
  const session = await c.create(P, ACTOR, 'contextual');
  const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
  assert.equal(turn.interaction, undefined);
  assert.equal(store.rows.get(session.id)?.sessionContext.pendingKey, undefined);
});

for (const key of [undefined, '', '   ', 42, ['onset'], 'a'.repeat(61), '__proto__', 'constructor', 'minimal_followup']) {
  test(`Minimal rejects a material question with invalid fact key ${JSON.stringify(key)}`, async () => {
    const model = scriptedModel(() => JSON.stringify({ status: 'ASK_USER', question: 'متى بدأ الدم؟', factKey: key, answerType: 'date' }));
    const store = fakeStore();
    const c = svc(store, model);
    const session = await c.create(P, ACTOR, 'contextual');
    const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'ما الحكم؟' });
    assert.notEqual(turn.status, 'needs_information');
    assert.equal(turn.interaction, undefined);
    assert.equal(store.rows.get(session.id)?.sessionContext.pendingKey, undefined);
    assert.equal(turn.answer?.label, undefined);
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

test('the corrected bleeding start reaches the skill as a confirmed date and supersedes the prior result', async () => {
  const store = fakeStore();
  const model = scriptedModel(() => ask('متى توقف الدم؟'));
  const c = svc(store, model);
  const session = await c.create(P, ACTOR, 'contextual');
  const at = '2026-11-01T00:00:00.000Z';
  store.rows.set(session.id, {
    ...session,
    sessionContext: {
      ...session.sessionContext,
      facts: { last_bleeding_start: '2026-11-01' },
      factMeta: { last_bleeding_start: {
        provenance: 'user_answer', certainty: 'CERTAIN', at,
        admission: { skillId: 'naqaa.fiqh-hayd-minimal', interaction: { type: 'date' } },
      } },
      lastGroundedResult: { skillId: 'naqaa.fiqh-hayd-minimal', status: 'DECIDED', evidenceRefs: ['chunk-old'] },
    },
  });

  const turn = await c.handleMessage(P, ACTOR, session.id, { text: 'لا، قصدي 2026-11-02' });
  const stored = store.rows.get(session.id)!.sessionContext;
  const knownFact = model.prompts[0].split('\n').find((line) => line.startsWith('- last_bleeding_start = '));
  assert.equal(knownFact, '- last_bleeding_start = "2026-11-02" (CERTAIN/user_answer)');
  assert.equal(stored.facts.last_bleeding_start, '2026-11-02');
  assert.equal(stored.lastGroundedResult, undefined);
  assert.equal(turn.caseState?.groundedResult, 'invalidated');
  assert.deepEqual(stored.factMeta?.last_bleeding_start.superseded, [{ value: '2026-11-01', at }]);
});
