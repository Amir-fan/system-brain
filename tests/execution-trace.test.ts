/**
 * K28 — Skill Tester Execution Trace (observability/diagnostics) focused tests.
 *
 * Proves the trace REPORTS what the runtime measured for ANY Skill (no domain fields), that it
 * never carries prompts/reasoning/secrets, and that it does not alter what a Skill returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { providerError } from '../src/core/model-gateway/gateway-errors.ts';
import { createFiqhHaydMinimalSkill } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { evidenceLabels, summarizeExecution, formatDuration, codeNote } from '../frontend/src/lib/executionTrace.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillDefinition, SkillExecutionContext } from '../src/core/skill/skill.ts';
import type { RunRecord, RuntimePersistence } from '../src/core/runtime/runtime.ports.ts';
import type { ProjectBoundaryReaders } from '../src/core/authorization/project-boundary.ts';
import type { ModelGateway, ModelGatewayInput, ModelGatewayOutput } from '../src/core/model-gateway/model-gateway.ts';

function fakePersistence(opts: { failUpdateTimes?: number } = {}) {
  const runs: Record<string, RunRecord> = {};
  let failuresLeft = opts.failUpdateTimes ?? 0;
  const store = {
    runs,
    async getProject(id: string) {
      return id === 'p' ? { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' } : null;
    },
    async getMembership(projectId: string, actor: string) {
      return { projectId, actor, role: 'owner' as const, createdAt: '' };
    },
    async createRun(run: RunRecord) {
      runs[run.id] = run;
    },
    async updateRun(id: string, patch: Partial<RunRecord>) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('run update failed: PGRST000 simulated');
      }
      runs[id] = { ...(runs[id] ?? { id }), ...patch } as RunRecord;
    },
  };
  return store as typeof store & RuntimePersistence & ProjectBoundaryReaders;
}

function skillWith(opts: {
  id: string;
  model?: boolean;
  knowledge?: boolean;
  notes?: string[];
  status?: string;
  execute?: (ctx: SkillExecutionContext) => Promise<unknown>;
}): SkillDefinition {
  return {
    id: opts.id,
    version: 1,
    description: 'trace fixture',
    requirements: { understanding: false, memory: false, knowledge: opts.knowledge === true, model: opts.model === true },
    validateInput: () => ({ ok: true }),
    validateOutput: () => ({ ok: true }),
    execute:
      opts.execute ??
      (async () => ({
        trace: { status: opts.status ?? 'ANSWER', notes: opts.notes ?? [], ...(opts.status === 'ANSWER' ? { acceptedEvidenceRefs: ['c1'], sourceSupport: 'SUPPORTED' } : {}) },
        answer: opts.status === 'ANSWER' || !opts.status ? { text: 'ok' } : undefined,
      })),
  };
}

function runtimeFor(skill: SkillDefinition, deps: { persistence: RuntimePersistence & ProjectBoundaryReaders; modelGateway?: ModelGateway; knowledge?: () => unknown }) {
  const registry = new MapSkillRegistry();
  registry.register(skill);
  return new SkillsRuntime({
    persistence: deps.persistence,
    registry,
    ...(deps.modelGateway ? { modelGateway: deps.modelGateway } : {}),
    ...(deps.knowledge ? { knowledge: (() => deps.knowledge!()) as never } : {}),
  });
}

const input = { projectId: 'p', actor: 'a', skillId: 'x', payload: { text: 'hi' } };
const gatewayOk = (): ModelGateway =>
  ({ generateText: async (_i: ModelGatewayInput): Promise<ModelGatewayOutput> => ({ text: 'answer', provider: 'openrouter', model: 'test/model', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }) }) as unknown as ModelGateway;
const knowledgeFake = { search: async () => [], resolveSources: async () => [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }], adjacent: async () => [] };

// A — a successful model call renders SUCCESS with duration + tokens
test('K28/A: a successful model call is reported with duration and tokens', async () => {
  const skill = skillWith({ id: 't.one', model: true, execute: async (ctx) => { await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'x' }); return { trace: { status: 'ANSWER', acceptedEvidenceRefs: ['c1'], sourceSupport: 'SUPPORTED' } }; } });
  const res = await runtimeFor(skill, { persistence: fakePersistence(), modelGateway: gatewayOk() }).execute({ ...input, skillId: 't.one' });
  const ex = res.trace?.execution;
  assert.ok(ex, 'an execution trace is always attached');
  const call = ex!.stages.find((s) => s.stage === 'MODEL_CALL');
  assert.equal(call?.status, 'SUCCESS');
  assert.equal(call?.index, 1);
  assert.equal(typeof call?.duration_ms, 'number');
  assert.equal(call?.detail?.input_tokens, 10);
  assert.equal(call?.detail?.output_tokens, 20);
  assert.equal(call?.detail?.provider, 'openrouter');
  assert.equal(ex!.outcome, 'COMPLETED');
  assert.ok(typeof ex!.totals?.total_ms === 'number' && typeof ex!.slowest?.duration_ms === 'number');
});

// B — a Knowledge call renders duration + operation
test('K28/B: a Knowledge call is reported with its operation and duration', async () => {
  const skill = skillWith({ id: 't.k', knowledge: true, execute: async (ctx) => { await ctx.knowledge!.search({ query: 'q' }); return { trace: { status: 'ANSWER', acceptedEvidenceRefs: ['c1'], sourceSupport: 'SUPPORTED' } }; } });
  const res = await runtimeFor(skill, { persistence: fakePersistence(), knowledge: () => knowledgeFake }).execute({ ...input, skillId: 't.k' });
  const k = res.trace!.execution!.stages.filter((s) => s.stage === 'KNOWLEDGE_SEARCH');
  assert.ok(k.length >= 1);
  assert.equal(k[0].status, 'SUCCESS');
  assert.equal(typeof k[0].duration_ms, 'number');
  assert.ok(typeof k[0].detail?.operation === 'string');
});

// C — a parser failure is reported truthfully (and nothing else changes)
test('K28/C: an unreadable output envelope is reported as INVALID_OUTPUT_ENVELOPE', async () => {
  const skill = skillWith({ id: 't.parse', status: 'INSUFFICIENT_EVIDENCE', notes: ['unreadable_model_output'] });
  const res = await runtimeFor(skill, { persistence: fakePersistence() }).execute({ ...input, skillId: 't.parse' });
  const ex = res.trace!.execution!;
  assert.equal(ex.outcome, 'TECHNICAL_FAILURE');
  assert.equal(ex.failureStage, 'OUTPUT_PARSE');
  assert.equal(ex.failureCode, 'INVALID_OUTPUT_ENVELOPE');
  assert.equal(ex.stages.find((s) => s.stage === 'OUTPUT_PARSE')?.status, 'FAILED');
  // the Skill's own verdict is untouched by the reporting
  assert.equal(res.trace!.status, 'INSUFFICIENT_EVIDENCE');
});

// D — a provider timeout is reported as MODEL_TIMEOUT on the thrown path
test('K28/D: a provider timeout carries MODEL_TIMEOUT in the attached trace', async () => {
  const skill = skillWith({ id: 't.timeout', model: true, execute: async (ctx) => { await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'x' }); return {}; } });
  const gateway = { generateText: async () => { throw providerError('chat completion timed out', 'PROVIDER_CHAT_TIMEOUT', { timeoutMs: 300_000 }); } } as unknown as ModelGateway;
  let captured: Record<string, unknown> | undefined;
  try {
    await runtimeFor(skill, { persistence: fakePersistence(), modelGateway: gateway }).execute({ ...input, skillId: 't.timeout' });
  } catch (e) {
    captured = (e as { execution?: Record<string, unknown> }).execution;
  }
  assert.ok(captured, 'the thrown error carries the measured trace');
  assert.equal(captured!.outcome, 'TECHNICAL_FAILURE');
  assert.equal(captured!.failureCode, 'MODEL_TIMEOUT');
  const call = (captured!.stages as Array<{ stage: string; status: string; detail?: Record<string, unknown> }>).find((s) => s.stage === 'MODEL_CALL');
  assert.equal(call?.status, 'TIMEOUT');
  assert.equal(call?.detail?.timeout, true);
});

// E — citation failure is a reported stage, not a behaviour change
test('K28/E: a citation failure is reported on CITATION_VALIDATION without changing the verdict', async () => {
  const skill = skillWith({ id: 't.cite', status: 'INSUFFICIENT_EVIDENCE', notes: ['citation_rejected'] });
  const res = await runtimeFor(skill, { persistence: fakePersistence() }).execute({ ...input, skillId: 't.cite' });
  const ex = res.trace!.execution!;
  assert.equal(ex.failureStage, 'CITATION_VALIDATION');
  assert.equal(ex.failureCode, 'CITATION_VALIDATION_FAILED');
  assert.equal(res.trace!.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(res.answer?.evidenceIds, undefined);
});

// F — persistence failure is distinguishable
test('K28/F: a failed run finalization is reported on the PERSISTENCE stage', async () => {
  const skill = skillWith({ id: 't.persist', status: 'ANSWER' });
  const res = await runtimeFor(skill, { persistence: fakePersistence({ failUpdateTimes: 99 }) }).execute({ ...input, skillId: 't.persist' });
  const ex = res.trace!.execution!;
  assert.equal(ex.stages.find((s) => s.stage === 'PERSISTENCE')?.status, 'FAILED');
  assert.equal(ex.failureCode, 'PERSISTENCE_FAILED');
});

// H — privacy: safe fields only
test('K28/H: the trace carries no prompts, reasoning, or credentials', async () => {
  const skill = skillWith({
    id: 't.privacy',
    model: true,
    execute: async (ctx) => {
      await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'SECRET-PROMPT-TEXT' });
      return { trace: { status: 'ANSWER', notes: ['reason=internal'], acceptedEvidenceRefs: ['c1'], sourceSupport: 'SUPPORTED' } };
    },
  });
  const res = await runtimeFor(skill, { persistence: fakePersistence(), modelGateway: gatewayOk() }).execute({ ...input, skillId: 't.privacy' });
  const blob = JSON.stringify(res.trace!.execution);
  for (const needle of ['SECRET-PROMPT-TEXT', 'reason=', 'messages', 'authorization', 'apiKey', 'Bearer', 'reasoning']) {
    assert.ok(!blob.includes(needle), `the trace must not contain ${needle}`);
  }
  const allowed = new Set(['stages', 'stage', 'index', 'status', 'duration_ms', 'detail', 'outcome', 'failureStage', 'failureCode', 'slowest', 'totals', 'provider', 'model', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'served_by', 'finish_reason', 'timeout', 'operation', 'errorCode', 'total_ms', 'model_ms', 'knowledge_ms', 'core_ms', 'persistence_ms']);
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { keys.add(k); walk(val); }
  };
  walk(res.trace!.execution);
  for (const k of keys) assert.ok(allowed.has(k), `unexpected trace key: ${k}`);
});

// I — works for a Skill with no trace of its own (no new domain fields)
test('K28/I: a Skill that returns no trace still gets an execution trace', async () => {
  const skill = skillWith({ id: 't.bare', execute: async () => ({ answer: { text: 'x' } }) });
  const res = await runtimeFor(skill, { persistence: fakePersistence() }).execute({ ...input, skillId: 't.bare' });
  assert.ok(res.trace?.execution, 'the runtime supplies the trace itself');
  assert.equal(res.trace!.execution!.stages[0].stage, 'REQUEST');
});

// J — the Minimal Mind's behaviour is unchanged by the diagnostics
test('K28/J: the Minimal Mind behaves exactly as before (trace is additive only)', async () => {
  // flexible keeps the pre-RX2 behaviour (plain-message terminal is valid).
  const skill = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService(), responseMode: 'flexible' });
  const scripted = [
    JSON.stringify({ action: 'USE_TOOL', tool: 'search_knowledge', query: 'q' }),
    JSON.stringify({ action: 'TERMINAL', status: 'ANSWER', message: 'الجواب.', evidenceRefs: ['chunk-a'] }),
  ];
  let call = 0;
  const ctx = {
    projectId: 'p', actor: 'a', input: { text: 'ما الحكم؟', recentTurns: [] },
    knowledge: {
      async search() { return [{ chunkId: 'chunk-a', documentId: 'd', sourceId: 'src-approved-1', sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 1, text: 'نص', score: 0.5 }]; },
      async resolveSources() { return [{ id: 'src-approved-1', title: APPROVED_SOURCE_TITLES[0] }]; },
      async adjacent() { return []; },
    },
    model: { async generateText() { const t = scripted[Math.min(call, scripted.length - 1)]; call += 1; return { text: t, model: 'scripted-model' }; } },
  } as unknown as SkillExecutionContext;
  const out = (await skill.execute(ctx)) as Record<string, any>;
  assert.equal(out.trace.status, 'ANSWER');
  assert.equal(out.trace.sourceSupport, 'SUPPORTED');
  assert.deepEqual(out.answer.evidenceIds, ['chunk-a']);
  assert.ok(out.trace.notes.includes('minimal_mind_v0'), 'the Skill marker is untouched');
  assert.equal(out.caseFacts, undefined);
});

// G — presentation helpers: human-readable labels, no raw UUIDs
test('K28/G: evidence labels never show raw ids in the normal view', () => {
  const uuid = '5213b63e-ff49-469f-8874-217b0f0f6b8e';
  assert.deepEqual(evidenceLabels({ evidenceIds: [uuid] }), ['مقطع 1']);
  assert.deepEqual(evidenceLabels({ evidenceIds: [uuid, '709d660c-d7f4-49a8-bf7e-f046c2937000'] }), ['مقطع 1', 'مقطع 2']);
  assert.deepEqual(evidenceLabels({ sourceTitle: 'الحيض الالوكة', evidenceIds: [uuid] }), ['الحيض الالوكة']);
  assert.deepEqual(evidenceLabels({ acceptedRefs: [uuid] }), ['مقطع 1']);
  assert.deepEqual(evidenceLabels({ traceEvidence: [{ chunkId: uuid }] }), ['مقطع 1']);
  assert.ok(!evidenceLabels({ evidenceIds: [uuid] }).join('').includes(uuid));
  assert.equal(formatDuration(8.4 * 1000), '8.4 ث');
  assert.equal(formatDuration(undefined), 'غير متاح');
  assert.equal(codeNote('INVALID_OUTPUT_ENVELOPE')?.includes('صيغة جواب صالحة'), true);
  const s = summarizeExecution({
    outcome: 'TECHNICAL_FAILURE',
    stages: [{ stage: 'MODEL_CALL', index: 2, status: 'SUCCESS', duration_ms: 74250 }],
    failureStage: 'OUTPUT_PARSE',
    failureCode: 'INVALID_OUTPUT_ENVELOPE',
    slowest: { stage: 'MODEL_CALL', index: 2, duration_ms: 74250 },
    totals: { total_ms: 100000, model_ms: 90000, knowledge_ms: 5000, core_ms: 3000, persistence_ms: 2000 },
  });
  assert.equal(s.outcomeLabel, 'فشل تقني');
  assert.equal(s.slowestLabel, 'استدعاء الموديل #2 — 74.3 ث');
  assert.equal(s.failureLabel, 'تنسيق النتيجة');
  assert.equal(s.shares?.model, 90);
});
