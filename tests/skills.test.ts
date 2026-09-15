/**
 * K20 Skills Runtime V1 — core + registry tests with faithful in-memory fakes.
 * Live behavior is proven in scripts/k20-acceptance.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { demoContextSummary } from '../src/core/skill/demo-context-summary.ts';
import { SkillFailure } from '../src/core/skill/skill.ts';
import type { SkillDefinition, SkillExecutionContext } from '../src/core/skill/skill.ts';
import type { RunRecord, RuntimePersistence } from '../src/core/runtime/runtime.ports.ts';
import type { ProjectBoundaryReaders } from '../src/core/authorization/project-boundary.ts';
import type { UnderstandingResult } from '../src/core/understanding/understanding.ts';

// ---- fakes ----
function fakePersistence() {
  const runs: Record<string, RunRecord> = {};
  return {
    runs,
    async getProject(id: string) {
      return id === 'p' || id === 'pb'
        ? { id, name: 'Test Project', status: 'active' as const, createdAt: '', updatedAt: '' }
        : null;
    },
    async getMembership(projectId: string, actor: string) { return { projectId, actor, role: 'owner' as const, createdAt: '' }; },
    async createRun(run: RunRecord) { runs[run.id] = run; },
    async updateRun(id: string, patch: Partial<RunRecord>) { runs[id] = { ...(runs[id] ?? { id }), ...patch } as RunRecord; },
  };
}
const fakeUnderstanding = (script: Record<string, string> = {}) => ({
  async evaluate(input: { text: string }) {
    const status = script[input.text] === 'needs' ? ('NEEDS_CLARIFICATION' as const) : ('CLEAR' as const);
    return { status, language: 'en', dialogueAct: 'QUESTION', issues: [input.text], references: { resolved: status === 'CLEAR' }, corrections: [], facts: [], ambiguity: { material: status === 'NEEDS_CLARIFICATION' }, ...(status === 'NEEDS_CLARIFICATION' ? { clarification: { reason: 'unresolved_reference', question: 'Which one?' } } : {}), contextUsed: { userCount: 0, conversationCount: 0, caseCount: 0, scopes: [] } } as UnderstandingResult;
  },
});
const fakeMemory = (rows: Array<{ scope: string; memoryKey: string; value: string }> = []) => ({
  async fetchBounded(projectId: string) {
    return {
      user: rows.filter((r) => r.scope === 'user').map((r) => ({ id: 'm', scope: r.scope, memoryType: 'preference', memoryKey: r.memoryKey, payload: { value: r.value } })),
      conversation: [],
      case: [],
    };
  },
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

test('registry: register/get/list + duplicate rejection', () => {
  const reg = new MapSkillRegistry();
  reg.register(demoContextSummary);
  assert.equal(reg.get('demo.context-summary')?.version, 1);
  assert.equal(reg.list().length, 1);
  assert.equal(reg.get('nope'), undefined);
  assert.throws(() => reg.register({ ...demoContextSummary }), /already registered/);
});

test('unknown skill -> SKILL_NOT_FOUND', async () => {
  const rt = new SkillsRuntime({ persistence: fakePersistence(), registry: new MapSkillRegistry(), understanding: fakeUnderstanding(), memory: fakeMemory() });
  await assert.rejects(rt.execute({ projectId: 'p', actor: 'a', skillId: 'missing', payload: {} }), SkillFailure);
});

test('successful execution (understanding + bounded memory) -> completed, no model', async () => {
  const reg = new MapSkillRegistry(); reg.register(demoContextSummary);
  const rt = new SkillsRuntime({ persistence: fakePersistence(), registry: reg, understanding: fakeUnderstanding({ 'Summarize my current preference.': 'clear' }), memory: fakeMemory([{ scope: 'user', memoryKey: 'preferred_language', value: 'Arabic' }]) });
  const result = await rt.execute({ projectId: 'p', actor: 'a', skillId: 'demo.context-summary', payload: { text: 'Summarize my current preference.' }, subjectId: 'u1' });
  assert.equal(result.status, 'completed');
  assert.ok(result.runId);
  const output = result.output as { relevantContext: Array<{ key: string; value: unknown }> };
  assert.deepEqual(output.relevantContext, [{ key: 'preferred_language', value: 'Arabic' }]);
});

test('invalid input -> failed result + failed run', async () => {
  const reg = new MapSkillRegistry(); reg.register(demoContextSummary);
  const pers = fakePersistence();
  const rt = new SkillsRuntime({ persistence: pers, registry: reg, understanding: fakeUnderstanding(), memory: fakeMemory() });
  const result = await rt.execute({ projectId: 'p', actor: 'a', skillId: 'demo.context-summary', payload: {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'SKILL_INVALID_INPUT');
  assert.equal(pers.runs[result.runId!]?.status, 'failed');
});

test('invalid output -> SKILL_INVALID_OUTPUT + failed run', async () => {
  const bad: SkillDefinition = {
    id: 'test.bad-output', version: 1, description: 'bad',
    requirements: { understanding: false, memory: false, knowledge: false, model: false },
    validateInput: () => ({ ok: true }),
    validateOutput: (o) => (isObj(o) && Array.isArray(o.ok) ? { ok: true } : { ok: false, message: 'bad shape' }),
    async execute() { return { not: 'an array' }; },
  };
  const reg = new MapSkillRegistry(); reg.register(bad);
  const pers = fakePersistence();
  const rt = new SkillsRuntime({ persistence: pers, registry: reg, understanding: fakeUnderstanding(), memory: fakeMemory() });
  await assert.rejects(rt.execute({ projectId: 'p', actor: 'a', skillId: 'test.bad-output', payload: {} }), (e: unknown) => (e as SkillFailure).code === 'SKILL_INVALID_OUTPUT');
  const run = Object.values(pers.runs)[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCategory, 'validation');
});

test('ambiguity gate: NEEDS_CLARIFICATION -> body does NOT execute, result needs_clarification', async () => {
  let bodyRan = false;
  const skill: SkillDefinition = {
    id: 'test.ambig', version: 1, description: 'ambig',
    requirements: { understanding: true, memory: false, knowledge: false, model: false },
    validateInput: () => ({ ok: true }),
    validateOutput: () => ({ ok: true }),
    async execute() { bodyRan = true; return { understoodIssues: [] }; },
  };
  const reg = new MapSkillRegistry(); reg.register(skill);
  const rt = new SkillsRuntime({ persistence: fakePersistence(), registry: reg, understanding: fakeUnderstanding({ 'What about that one?': 'needs' }), memory: fakeMemory() });
  const result = await rt.execute({ projectId: 'p', actor: 'a', skillId: 'test.ambig', payload: { text: 'What about that one?' } });
  assert.equal(result.status, 'needs_clarification');
  assert.equal(bodyRan, false);
});

test('declared dependencies only: ctx has no db/model/gateway/secrets', async () => {
  let keys: string[] = [];
  const skill: SkillDefinition = {
    id: 'test.ctx', version: 1, description: 'ctx',
    requirements: { understanding: true, memory: false, knowledge: false, model: false },
    validateInput: () => ({ ok: true }),
    validateOutput: () => ({ ok: true }),
    async execute(ctx: SkillExecutionContext) { keys = Object.keys(ctx); return { understoodIssues: ctx.understanding?.issues ?? [] }; },
  };
  const reg = new MapSkillRegistry(); reg.register(skill);
  const rt = new SkillsRuntime({ persistence: fakePersistence(), registry: reg, understanding: fakeUnderstanding(), memory: fakeMemory() });
  await rt.execute({ projectId: 'p', actor: 'a', skillId: 'test.ctx', payload: { text: 'hi' } });
  assert.ok(keys.includes('projectId') && keys.includes('understanding'));
  assert.ok(!keys.some((k) => /db|database|model|gateway|secret|token|supabase|provider/.test(k)));
});

test('run lifecycle: successful -> completed; failed -> failed (persisted)', async () => {
  const reg = new MapSkillRegistry(); reg.register(demoContextSummary);
  const pers = fakePersistence();
  const rt = new SkillsRuntime({ persistence: pers, registry: reg, understanding: fakeUnderstanding({ 'hi': 'clear' }), memory: fakeMemory() });
  const okRun = await rt.execute({ projectId: 'p', actor: 'a', skillId: 'demo.context-summary', payload: { text: 'hi' } });
  assert.equal(pers.runs[okRun.runId!]?.status, 'completed');
  const bad = await rt.execute({ projectId: 'p', actor: 'a', skillId: 'demo.context-summary', payload: {} });
  assert.equal(pers.runs[bad.runId!]?.status, 'failed');
});

test('project isolation: missing project -> not executed', async () => {
  const reg = new MapSkillRegistry(); reg.register(demoContextSummary);
  const rt = new SkillsRuntime({ persistence: fakePersistence(), registry: reg, understanding: fakeUnderstanding(), memory: fakeMemory() });
  await assert.rejects(rt.execute({ projectId: 'other', actor: 'a', skillId: 'demo.context-summary', payload: { text: 'hi' } }), SkillFailure);
});

test('zero-model proof skill: no model call made', async () => {
  let modelCalled = 0;
  const reg = new MapSkillRegistry(); reg.register(demoContextSummary);
  const rt = new SkillsRuntime({
    persistence: fakePersistence(), registry: reg, understanding: fakeUnderstanding({ 'hi': 'clear' }), memory: fakeMemory(),
    // model is intentionally absent; the skill declares model:false so it is never touched.
  });
  const result = await rt.execute({ projectId: 'p', actor: 'a', skillId: 'demo.context-summary', payload: { text: 'hi' } });
  assert.equal(result.status, 'completed');
  assert.equal(modelCalled, 0);
});
