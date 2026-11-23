/**
 * P0.4 — structured terminal output for knowledge_answer / naqaa.fiqh-hayd-minimal@v2.
 * Proves the opt-in request field, the gateway mapping, the Skill's terminal-format behaviour,
 * and that non-structured requests are unchanged. No live/provider calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';
import { createFiqhHaydMinimalSkill } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import type { SkillExecutionContext } from '../src/core/skill/skill.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';

const CTX = (text: string): SkillExecutionContext =>
  ({
    projectId: 'p', actor: 'a', input: { text, recentTurns: [] },
    knowledge: {
      async resolveSources() { return [{ id: 'src-1', title: APPROVED_SOURCE_TITLES[0] }]; },
      async search() { return [{ chunkId: 'chunk-1', documentId: 'd', sourceId: 'src-1', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 1, text: 'نص دليلي', score: 0.5 }]; },
      async adjacent() { return []; },
    },
    model: { async generateText(input: Record<string, unknown>) { return { text: JSON.stringify({ status: 'ANSWER', message: 'جواب', evidenceRefs: ['chunk-1'] }), model: 'test' }; } },
  }) as unknown as SkillExecutionContext;

const FORMAT = { name: 'minimal_terminal', strict: true, schema: { type: 'object', properties: { status: { type: 'string', enum: ['ASK_USER', 'ANSWER', 'INSUFFICIENT_EVIDENCE'] } }, required: ['status'], additionalProperties: false } };

function fetchCapture(captured: { body?: Record<string, unknown> }, reply: unknown = {}) {
  return (async (_url: string, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body ?? '{}'));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {}, model: 'm', ...(reply as Record<string, unknown>) }) } as unknown as Response;
  }) as unknown as typeof fetch;
}
const call = (gw: OpenRouterGateway, extra: Record<string, unknown> = {}) =>
  gw.generateText({ projectId: 'p', runId: 'r', capability: 'chat', input: { message: 'x' }, ...extra } as never);

for (const [finishReason, content] of [
  ['content_filter', ''],
  ['length', '{"status":"ANSWER"'],
  ['length', '{"status":"ASK_USER","question":"When?"}'],
  ['tool_calls', '{"status":"ASK_USER","question":"When?","factKey":"onset"}'],
  ['provider_specific_incomplete', '{"status":"ANSWER"}'],
  ['stop', '   '],
] as const) {
  test(`gateway rejects unusable completion: ${finishReason} / ${content}`, async () => {
    const gw = new OpenRouterGateway({ apiKey: 'k', defaultModel: 'm', fetchImpl: fetchCapture({}, {
      choices: [{ finish_reason: finishReason, message: { content } }],
    }) });
    await assert.rejects(call(gw), { kind: 'provider', code: 'PROVIDER_CHAT_INCOMPLETE' });
  });
}

// 1. The gateway sends response_format only when the caller asks for it
test('P04/A: response_format is sent exactly when requested', async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const gw = new OpenRouterGateway({ apiKey: 'k', defaultModel: 'm', fetchImpl: fetchCapture(captured) });
  await call(gw);
  assert.equal(captured.body!.response_format, undefined);
  await call(gw, { responseFormat: FORMAT });
  assert.deepEqual(captured.body!.response_format, { type: 'json_schema', json_schema: { name: FORMAT.name, strict: true, schema: FORMAT.schema } });
});

// 2. Non-structured requests are byte-identical to before
test('P04/B: a non-structured request body is unchanged', async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const gw = new OpenRouterGateway({ apiKey: 'k', defaultModel: 'm', fetchImpl: fetchCapture(captured), providerSort: '', reasoningEffort: '' });
  await call(gw, { maxOutputTokens: 512 });
  assert.deepEqual(Object.keys(captured.body!).sort(), ['max_tokens', 'messages', 'model']);
  assert.equal(captured.body!.response_format, undefined);
});

// 3. The Skill accepts all three valid terminal statuses and rejects an invalid one
test('P04/C: valid statuses are accepted; an invalid status fails closed', async () => {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'flexible' });
  for (const status of ['ANSWER', 'ASK_USER', 'INSUFFICIENT_EVIDENCE']) {
    const ctx = CTX('سؤال');
    (ctx.model as { generateText: (i: unknown) => Promise<{ text: string }> }).generateText = async () => ({
      text: JSON.stringify(
        status === 'ANSWER'
          ? { action: 'TERMINAL', status, message: 'جواب', evidenceRefs: ['chunk-1'] }
          : status === 'ASK_USER'
          ? { action: 'TERMINAL', status, question: 'سؤال؟', factKey: 'requested_fact', answerType: 'free_text' }
          : { action: 'TERMINAL', status, message: 'لا يكفي' },
      ),
    });
    const out = (await skill.execute(ctx)) as Record<string, unknown>;
    const trace = out.trace as { status?: string } | undefined;
    assert.equal(trace?.status === 'ANSWER' || trace?.status === 'NEED_INFO' || trace?.status === 'INSUFFICIENT_EVIDENCE', true, `status ${status} should be accepted`);
  }
  const ctx2 = CTX('سؤال');
  (ctx2.model as { generateText: (i: unknown) => Promise<{ text: string }> }).generateText = async () => ({ text: JSON.stringify({ action: 'TERMINAL', status: 'MAYBE', message: 'x' }) });
  const out2 = (await skill.execute(ctx2)) as Record<string, unknown>;
  assert.equal((out2.trace as { notes?: string[] })?.notes?.includes('unreadable_model_output'), true, 'invalid status must fail closed');
});

// 4. The terminal format is attached on every model call (superset of the tool request)
test('P04/D: the Skill attaches the terminal format to every generation', async () => {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'flexible' });
  const seen: Array<Record<string, unknown>> = [];
  const ctx = CTX('سؤال');
  (ctx.model as { generateText: (i: Record<string, unknown>) => Promise<{ text: string }> }).generateText = async (input) => {
    seen.push(input);
    return { text: JSON.stringify(seen.length === 1 ? { action: 'USE_TOOL', tool: 'search_knowledge', query: 'q' } : { action: 'TERMINAL', status: 'ANSWER', message: 'جواب', evidenceRefs: ['chunk-1'] }) };
  };
  await skill.execute(ctx);
  assert.ok(seen.every((c) => c.responseFormat && typeof c.responseFormat === 'object'), 'every call must carry the terminal format');
});

// 5. Citations still come only from tool-returned passages
test('P04/E: citation validation is unchanged', async () => {
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'flexible' });
  const ctx = CTX('سؤال');
  (ctx.model as { generateText: (i: unknown) => Promise<{ text: string }> }).generateText = async () => ({ text: JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: 'جواب', evidenceRefs: ['chunk-NOT-RETURNED'] }) });
  const out = (await skill.execute(ctx)) as Record<string, unknown>;
  assert.equal((out.trace as { notes?: string[] })?.notes?.includes('answer_without_tool_evidence'), true);
});

// 6. Other workloads/calls are unaffected (embeddings untouched)
test('P04/F: embeddings and non-chat paths carry no response_format', async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const gw = new OpenRouterGateway({ apiKey: 'k', defaultModel: 'm', fetchImpl: fetchCapture(captured, { data: [{ embedding: [1, 2] }], model: 'e', usage: {} }) });
  await gw.embedTexts({ projectId: 'p', runId: 'r', capability: 'embeddings', texts: ['x'] } as never);
  assert.equal(captured.body!.response_format, undefined);
});

test('model trust boundary: instructions are a system message and content stays user data', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let attempt = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 400, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{}' } }], usage: {}, model: 'm' }) } as Response;
  }) as typeof fetch;
  const gw = new OpenRouterGateway({ apiKey: 'k', defaultModel: 'm', fetchImpl });

  await gw.generateText({
    projectId: 'p', runId: 'r', capability: 'chat',
    instructions: 'trusted rules',
    input: { message: 'untrusted user and retrieved content' },
    responseFormat: FORMAT,
  });

  const expectedMessages = [
    { role: 'system', content: 'trusted rules' },
    { role: 'user', content: 'untrusted user and retrieved content' },
  ];
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].response_format, { type: 'json_schema', json_schema: FORMAT });
  assert.deepEqual(bodies[0].messages, expectedMessages);
  assert.deepEqual(bodies[1].messages, expectedMessages, 'json_object retry must preserve message roles');
  assert.deepEqual(bodies[1], { ...bodies[0], response_format: { type: 'json_object' } });
});
