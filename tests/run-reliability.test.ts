/**
 * A+ Reliability + Performance Observability — deterministic tests at the REAL runtime seam.
 *
 * Proves:
 *  A1  started → completed  /  started → failed (terminal state always reached)
 *  A1  a PostgREST-style update error is NOT silently swallowed (retried once, then reported)
 *  A2  a chat call is bounded by an explicit timeout and fails as a classified technical error
 *  A3  a provider/transport failure is NEVER converted into a domain verdict
 *  A+  generic stage timings (model/knowledge per call) are exposed, and are preserved for
 *      FAILED executions (the `[turn]` log line), so a failure does not erase performance evidence
 *
 * No real provider latency is involved: the gateway timeout uses an injected, controllable value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { providerError } from '../src/core/model-gateway/gateway-errors.ts';
import { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';
import { createKnowledgeEvidence } from '../src/platform/provider/knowledge-evidence.ts';
import { createSourceStorage } from '../src/platform/provider/source.storage.ts';
import { createIngestionPersistence } from '../src/platform/provider/ingestion.storage.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';
import { createFiqhHaydMinimalSkill } from '../src/domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { handleConversationMessage } from '../src/platform/api/conversation-handler.ts';
import type { SkillDefinition, SkillExecutionContext, SkillKnowledgeCapability } from '../src/core/skill/skill.ts';
import type { RunRecord, RuntimePersistence } from '../src/core/runtime/runtime.ports.ts';
import type { ProjectBoundaryReaders } from '../src/core/authorization/project-boundary.ts';
import type { ModelGateway, ModelGatewayInput, ModelGatewayOutput } from '../src/core/model-gateway/model-gateway.ts';
import { ConversationService } from '../src/core/conversation/conversation.service.ts';
import { ConversationFailure, type ConversationSession } from '../src/core/conversation/conversation.ts';
import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';

// ── fakes (external boundaries only) ────────────────────────────────────────

function fakePersistence(opts: { failUpdateTimes?: number } = {}) {
  const runs: Record<string, RunRecord> = {};
  let updates = 0;
  let failuresLeft = opts.failUpdateTimes ?? 0;
  const store = {
    runs,
    get updateCount() {
      return updates;
    },
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
      updates += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('run update failed: PGRST000 simulated');
      }
      runs[id] = { ...(runs[id] ?? { id }), ...patch } as RunRecord;
    },
  };
  return store as typeof store & RuntimePersistence & ProjectBoundaryReaders;
}

function fakeGateway(
  onCall: (input: ModelGatewayInput) => Promise<ModelGatewayOutput>,
): ModelGateway {
  return { generateText: onCall } as unknown as ModelGateway;
}

function skillWith(opts: {
  id: string;
  model?: boolean;
  knowledge?: boolean;
  execute: (ctx: SkillExecutionContext) => Promise<unknown>;
}): SkillDefinition {
  return {
    id: opts.id,
    version: 1,
    description: 'test skill',
    requirements: {
      understanding: false,
      memory: false,
      knowledge: opts.knowledge === true,
      model: opts.model === true,
    },
    validateInput: () => ({ ok: true }),
    validateOutput: () => ({ ok: true }),
    execute: opts.execute,
  };
}

function runtimeFor(skill: SkillDefinition, deps: {
  persistence: RuntimePersistence & ProjectBoundaryReaders;
  modelGateway?: ModelGateway;
  knowledge?: (projectId: string) => SkillKnowledgeCapability;
}) {
  const registry = new MapSkillRegistry();
  registry.register(skill);
  return new SkillsRuntime({
    persistence: deps.persistence,
    registry,
    ...(deps.modelGateway ? { modelGateway: deps.modelGateway } : {}),
    ...(deps.knowledge ? { knowledge: deps.knowledge } : {}),
  });
}

const input = { projectId: 'p', actor: 'a', skillId: 'x', payload: { text: 'hi' } };

/** Capture structured logs the runtime emits (console.log/error) without touching globals permanently. */
function captureLogs(): { lines: string[]; errors: string[]; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '));
  };
  return {
    lines,
    errors,
    restore: () => {
      console.log = log;
      console.error = error;
    },
  };
}

function turnLog(lines: string[]): Record<string, any> {
  const raw = lines.find((l) => l.includes('"[turn]"') || l.startsWith('[turn] '));
  assert.ok(raw, `no [turn] log line found in: ${JSON.stringify(lines)}`);
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

// ── A1: terminal state reachable ────────────────────────────────────────────

test('A1: successful execution finalizes the run as completed', async () => {
  const persistence = fakePersistence();
  const skill = skillWith({ id: 't.ok', execute: async () => ({ trace: { notes: ['done'] } }) });
  const runtime = runtimeFor(skill, { persistence });

  const res = await runtime.execute({ ...input, skillId: 't.ok' });
  assert.equal(res.status, 'completed');
  const run = persistence.runs[res.runId!];
  assert.equal(run.status, 'completed');
  assert.ok(typeof run.latencyMs === 'number' && run.latencyMs >= 0);
  assert.ok(run.completedAt);
  assert.equal(run.errorCategory, undefined);
});

test('A1: a failing execution finalizes the run as failed (never left started)', async () => {
  const persistence = fakePersistence();
  const skill = skillWith({ id: 't.boom', execute: async () => { throw new Error('boom'); } });
  const runtime = runtimeFor(skill, { persistence });
  const logs = captureLogs();
  try {
    await assert.rejects(() => runtime.execute({ ...input, skillId: 't.boom' }), /boom/);
  } finally {
    logs.restore();
  }
  const run = Object.values(persistence.runs)[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCategory, 'runtime');
  assert.ok(run.completedAt);
  assert.equal(turnLog(logs.lines).finalized, true);
});

// ── A1: persistence write errors are detected, retried and reported ─────────

test('A1: a transient run-update error is retried and the terminal state still lands', async () => {
  const persistence = fakePersistence({ failUpdateTimes: 1 });
  const skill = skillWith({ id: 't.retry', execute: async () => ({ trace: { notes: ['done'] } }) });
  const runtime = runtimeFor(skill, { persistence });

  const res = await runtime.execute({ ...input, skillId: 't.retry' });
  assert.equal(res.status, 'completed');
  assert.equal(persistence.updateCount, 2, 'one failed attempt + one successful retry');
  assert.equal(persistence.runs[res.runId!].status, 'completed');
});

test('A1: a persistent run-update error is NOT swallowed (reported, never silent)', async () => {
  const persistence = fakePersistence({ failUpdateTimes: 99 });
  const skill = skillWith({ id: 't.nostore', execute: async () => ({ trace: { notes: ['done'] } }) });
  const runtime = runtimeFor(skill, { persistence });
  const logs = captureLogs();
  let res: Awaited<ReturnType<typeof runtime.execute>>;
  try {
    res = await runtime.execute({ ...input, skillId: 't.nostore' });
  } finally {
    logs.restore();
  }
  assert.equal(persistence.updateCount, 2, 'bounded retry, not an unbounded loop');
  // Loud, machine-readable evidence — the failure is not silent.
  assert.ok(logs.errors.some((l) => l.includes('finalize_failed')), `expected a loud finalize error, got ${JSON.stringify(logs.errors)}`);
  assert.ok(logs.errors.some((l) => l.includes('PGRST000 simulated')), 'the store error reason is retained');
  // The skill's own outcome is not corrupted by a bookkeeping failure…
  assert.equal(res!.status, 'completed');
  assert.ok(res!.trace?.timings, 'timings still attached on the success path');
});

test('A1: the turn log records whether finalization persisted the terminal state', async () => {
  const persistence = fakePersistence({ failUpdateTimes: 99 });
  const skill = skillWith({ id: 't.nostore2', execute: async () => ({ trace: { notes: ['done'] } }) });
  const runtime = runtimeFor(skill, { persistence });
  const logs = captureLogs();
  try {
    await runtime.execute({ ...input, skillId: 't.nostore2' });
  } finally {
    logs.restore();
  }
  assert.equal(turnLog(logs.lines).finalized, false);
});

// ── A2: bounded chat timeout at the platform boundary ───────────────────────

const hangingFetch = (async (_url: string, init?: RequestInit) => {
  await new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // never resolves on purpose
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      return;
    }
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  });
  return undefined as unknown as Response;
}) as unknown as typeof fetch;

test('A2: a chat call that does not answer is bounded and fails as a classified timeout', async () => {
  const gateway = new OpenRouterGateway({
    apiKey: 'test-key',
    defaultModel: 'test/model',
    chatTimeoutMs: 40,
    fetchImpl: hangingFetch,
  });
  const started = Date.now();
  await assert.rejects(
    () => gateway.generateText({ projectId: 'p', runId: 'r', capability: 'c', modelId: 'test/model', input: { message: 'hi' } }),
    (e: unknown) => {
      const err = e as { kind?: string; code?: string };
      assert.equal(err.kind, 'provider');
      assert.equal(err.code, 'PROVIDER_CHAT_TIMEOUT');
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, 'the timeout, not an endurance test, ended the call');
});

test('A2: a transport failure is normalized to a provider error (not a raw throw)', async () => {
  const gateway = new OpenRouterGateway({
    apiKey: 'test-key',
    defaultModel: 'test/model',
    fetchImpl: (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => gateway.generateText({ projectId: 'p', runId: 'r', capability: 'c', modelId: 'test/model', input: { message: 'hi' } }),
    (e: unknown) => {
      const err = e as { kind?: string; code?: string };
      assert.equal(err.kind, 'provider');
      assert.equal(err.code, 'PROVIDER_CHAT_FAILED');
      return true;
    },
  );
});

test('A2: a stall AFTER the response headers is still classified as a provider timeout', async () => {
  // Headers arrive fine, then the body read aborts: this used to escape unclassified and
  // reach callers as a bare DOMException (losing the provider kind).
  const bodyStallFetch = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    return {
      ok: true,
      status: 200,
      json: async () =>
        await new Promise((_resolve, reject) => {
          if (!signal) return;
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
          );
        }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const gateway = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'test/model', chatTimeoutMs: 40, fetchImpl: bodyStallFetch });
  await assert.rejects(
    () => gateway.generateText({ projectId: 'p', runId: 'r', capability: 'c', modelId: 'test/model', input: { message: 'hi' } }),
    (e: unknown) => {
      const err = e as { kind?: string; code?: string };
      assert.equal(err.kind, 'provider', 'the provider kind must survive a mid-body failure');
      assert.equal(err.code, 'PROVIDER_CHAT_TIMEOUT');
      return true;
    },
  );
});

// ── A3: technical failure stays distinct from a domain verdict ─────────────

const minimalFiqh = createFiqhHaydMinimalSkill({ readiness: new DecisionReadinessService() });
const approvedCatalogue = (): SkillKnowledgeCapability => ({
  async resolveSources() { return [{ id: 'source', title: APPROVED_SOURCE_TITLES[0] }]; },
  async search() { return []; },
  async adjacent() { return []; },
});

const questionReply = JSON.stringify({ status: 'ASK_USER', question: 'متى بدأ الدم؟', factKey: 'onset', answerType: 'date' });
for (const [scenario, response, expectedCode] of [
  ['provider unavailable', () => new Response(null, { status: 503 }), 'PROVIDER_CHAT_FAILED'],
  ['request timed out', () => { throw new DOMException('timeout', 'TimeoutError'); }, 'PROVIDER_CHAT_TIMEOUT'],
  ['error envelope with successful HTTP status', () => Response.json({ error: { message: 'unavailable' } }), 'PROVIDER_CHAT_FAILED'],
  ['failed generation with a partial question', () => Response.json({
    choices: [{ finish_reason: 'error', message: { content: questionReply } }],
  }), 'PROVIDER_CHAT_FAILED'],
  ['missing completion choice', () => Response.json({ choices: [] }), 'PROVIDER_CHAT_FAILED'],
  ['error on the completion choice', () => Response.json({
    choices: [{ error: { message: 'backend unavailable' }, message: { content: questionReply } }],
  }), 'PROVIDER_CHAT_FAILED'],
  ['missing assistant content', () => Response.json({ choices: [{ message: {} }] }), 'PROVIDER_CHAT_FAILED'],
  ['filtered empty completion', () => Response.json({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }), 'PROVIDER_CHAT_INCOMPLETE'],
  ['truncated completion', () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"status":"ANSWER"' } }] }), 'PROVIDER_CHAT_INCOMPLETE'],
  ['truncated but parseable question', () => Response.json({ choices: [{ finish_reason: 'length', message: { content: questionReply } }] }), 'PROVIDER_CHAT_INCOMPLETE'],
  ['tool call with parseable question', () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: questionReply } }] }), 'PROVIDER_CHAT_INCOMPLETE'],
] as const) {
  test(`a fiqh turn fails at the provider boundary on ${scenario}`, async () => {
    const persistence = fakePersistence();
    let attempts = 0;
    const runtime = runtimeFor(minimalFiqh, {
      persistence,
      knowledge: approvedCatalogue,
      modelGateway: new OpenRouterGateway({
        apiKey: 'test-key', defaultModel: 'test/model',
        fetchImpl: async () => { attempts++; return response(); },
      }),
    });
    await assert.rejects(runtime.execute({ ...input, skillId: minimalFiqh.id }), { kind: 'provider', code: expectedCode });
    assert.equal(attempts, 1);
    assert.deepEqual(Object.values(persistence.runs).map(r => [r.status, r.errorCategory]), [['failed', 'provider']]);
  });
}

test('a provider outage on the JSON-mode compatibility retry terminates the same fiqh run', async () => {
  const persistence = fakePersistence();
  const requests: Array<{ model: string; response_format: { type: string } }> = [];
  const runtime = runtimeFor(minimalFiqh, {
    persistence,
    knowledge: approvedCatalogue,
    modelGateway: new OpenRouterGateway({
      apiKey: 'fixture', defaultModel: 'test/model',
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: requests.length === 1 ? 400 : 503 });
      },
    }),
  });
  await assert.rejects(runtime.execute({ ...input, skillId: minimalFiqh.id }), { code: 'PROVIDER_CHAT_FAILED' });
  assert.deepEqual(requests.map(r => [r.model, r.response_format.type]), [
    ['test/model', 'json_schema'], ['test/model', 'json_object'],
  ]);
  assert.deepEqual(Object.values(persistence.runs).map(r => [r.status, r.errorCategory]), [['failed', 'provider']]);
});

function evidenceDb(fetchImpl: typeof fetch) {
  return createClient('https://fixture.invalid', 'test-key', {
    global: { fetch: fetchImpl }, auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseDatabase;
}

const readFailure = () => Response.json({ code: 'TEST', message: 'internal detail' }, { status: 400 });

test('unavailable approved-source storage fails the fiqh run, while an empty catalogue yields an evidence gap', async () => {
  let unavailable = true;
  const db = evidenceDb(async () => unavailable ? readFailure() : Response.json([]));
  const persistence = fakePersistence();
  const runtime = runtimeFor(minimalFiqh, {
    persistence,
    modelGateway: fakeGateway(async () => assert.fail('no model call before approved sources are resolved')),
    knowledge: projectId => createKnowledgeEvidence({
      projectId,
      sources: createSourceStorage(db),
      retrieval: { async search() { return assert.fail('no retrieval before approved sources are resolved'); } },
      chunks: { async getChunk() { return null; }, async listChunkSummaries() { return []; } },
    }),
  });
  await assert.rejects(runtime.execute({ ...input, skillId: minimalFiqh.id }), /source catalogue read failed/);
  unavailable = false;
  const empty = await runtime.execute({ ...input, skillId: minimalFiqh.id });
  assert.deepEqual(Object.values(persistence.runs).map(r => [r.status, r.errorCategory]), [
    ['failed', 'runtime'], ['completed', undefined],
  ]);
  assert.equal(empty.trace?.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(empty.answer?.label, undefined);
});

test('fiqh evidence reads preserve a failed chunk lookup, neighbour listing, or source-title read', async t => {
  const anchor = { id: 'a', document_id: 'd', source_id: 's', chunk_index: 1 };
  const neighbour = { ...anchor, id: 'b', chunk_index: 2 };
  for (const [stage, responses, operation] of [
    ['anchor', [], 'adjacent'],
    ['neighbour list', [[anchor]], 'adjacent'],
    ['neighbour text', [[anchor], [neighbour]], 'adjacent'],
    ['cached chunk', [], 'loadByIds'],
    ['source title', [[anchor]], 'loadByIds'],
    ['retrieved chunk index', [], 'search'],
  ] as const) {
    await t.test(stage, async () => {
      let i = 0;
      const db = evidenceDb(async () => i < responses.length ? Response.json(responses[i++]) : readFailure());
      const evidence = createKnowledgeEvidence({
        projectId: 'p', sources: createSourceStorage(db), chunks: createIngestionPersistence(db),
        retrieval: { async search({ query }) { return {
          query, modelId: 'test', candidates: { semantic: 1, lexical: 0 }, rawBest: { semantic: 1, lexical: null },
          results: [{
            chunkId: 'a', documentId: 'd', sourceId: 's', text: 'passage', score: 1,
            retrievalSignals: { foundBy: ['semantic'], fusedScore: 1, diverse: true },
          }],
          confidence: { resultCount: 1, topFusedScore: 1, topSemanticScore: 1, topLexicalScore: null, agreement: 0, singleRetrieverEvidence: true },
          timings: { queryEmbeddingMs: 0, vectorSearchMs: 0, lexicalSearchMs: 0, fusionMs: 0, totalMs: 0 },
        }; } },
      });
      const reads = {
        adjacent: () => evidence.adjacent('a'),
        loadByIds: () => evidence.loadByIds!(['a']),
        search: () => evidence.search({ query: 'q' }),
      };
      await assert.rejects(reads[operation], /read failed/);
    });
  }
  const db = evidenceDb(async () => Response.json([]));
  const emptyChunks = createIngestionPersistence(db);
  assert.equal(await emptyChunks.getChunk('p', 'missing'), null);
  assert.deepEqual(await emptyChunks.listChunkSummaries('p', 'empty'), []);
});

test('A3: a provider timeout is a technical failure — never a needs_information/insufficient result', async () => {
  const persistence = fakePersistence();
  const skill = skillWith({
    id: 't.provider',
    model: true,
    execute: async (ctx) => {
      await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'x' });
      return { trace: { notes: ['should not be reached'] } };
    },
  });
  const runtime = runtimeFor(skill, {
    persistence,
    modelGateway: fakeGateway(async () => {
      throw providerError('chat completion timed out', 'PROVIDER_CHAT_TIMEOUT', { timeoutMs: 300_000 });
    }),
  });
  const logs = captureLogs();
  try {
    await assert.rejects(
      () => runtime.execute({ ...input, skillId: 't.provider' }),
      (e: unknown) => (e as { code?: string }).code === 'PROVIDER_CHAT_TIMEOUT',
    );
  } finally {
    logs.restore();
  }
  const run = Object.values(persistence.runs)[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.errorCategory, 'provider', 'technical failure is classified as provider');
  const logged = turnLog(logs.lines);
  assert.equal(logged.outcome, 'failed');
  assert.equal(logged.errorCategory, 'provider');
  assert.notEqual(logged.outcome, 'insufficient_evidence');
});

test('A3: the conversation API reports a provider failure as a temporary technical error', async () => {
  const boundary: ProjectBoundaryReaders = {
    async getProject(id: string) {
      return id === 'p' ? { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' } : null;
    },
    async getMembership(projectId: string, actor: string) {
      return { projectId, actor, role: 'owner' as const, createdAt: '' };
    },
  };
  const providerDeps = {
    boundary,
    service: {
      async handleMessage() {
        throw providerError('chat completion transport failure', 'PROVIDER_CHAT_FAILED', { reason: 'transport' });
      },
    } as unknown as ConversationService,
  };
  const res = await handleConversationMessage(providerDeps, 'p', 'a', 'c1', { text: 'hi' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 503);
    assert.equal(res.error.category, 'provider');
    assert.equal(res.error.message, 'تعذر إكمال الطلب مؤقتًا. حاولي مرة أخرى.');
    const body = JSON.stringify(res);
    assert.equal((res.error as { code?: string }).code, undefined, 'no internal error code exposed to the client');
    assert.ok(!/openrouter|stack|PROVIDER_|transport/i.test(body), `no provider internals exposed: ${body}`);
  }
});

test('the conversation API stops at the selected fiqh skill on outage even with a prior grounded result', async () => {
  const boundary = fakePersistence();
  const runtime = runtimeFor(minimalFiqh, {
    persistence: boundary,
    modelGateway: fakeGateway(async () => { throw providerError('unavailable', 'PROVIDER_CHAT_FAILED'); }),
    knowledge: approvedCatalogue,
  });
  const requested: string[] = [];
  let session: ConversationSession;
  const service = new ConversationService({
    persistence: {
      async create(s) { session = s; return s; },
      async get() { return session; },
      async save() { return assert.fail('a failed turn cannot publish a replacement answer'); },
    },
    understanding: new UnderstandingService(),
    skills: { execute(input) { requested.push(input.skillId); return runtime.execute(input); } },
    defaultSkillId: 'demo.conversation-eligibility',
  });
  session = await service.create('p', 'a', 'private');
  session.sessionContext.lastGroundedResult = {
    skillId: minimalFiqh.id, status: 'DECIDED', decision: 'prior decision', evidenceRefs: ['earlier'],
  };
  const res = await handleConversationMessage({ boundary, service }, 'p', 'a', session.id, {
    text: 'رأيت دما اليوم، ما الحكم؟', skillId: minimalFiqh.id,
  });
  assert.ok(!res.ok);
  assert.equal(res.status, 503);
  assert.equal(res.error.category, 'provider');
  assert.equal('data' in res, false);
  assert.doesNotMatch(JSON.stringify(res), /prior decision|earlier/);
  assert.deepEqual(requested, [minimalFiqh.id]);
});

test('A3 regression: a non-provider execution failure keeps the existing generic error', async () => {
  const boundary: ProjectBoundaryReaders = {
    async getProject(id: string) {
      return id === 'p' ? { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' } : null;
    },
    async getMembership(projectId: string, actor: string) {
      return { projectId, actor, role: 'owner' as const, createdAt: '' };
    },
  };
  const deps = {
    boundary,
    service: {
      async handleMessage() {
        throw new Error('unexpected internal failure');
      },
    } as unknown as ConversationService,
  };
  const res = await handleConversationMessage(deps, 'p', 'a', 'c1', { text: 'hi' });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 500);
    assert.equal(res.error.message, 'تعذر معالجة الرسالة.');
  }
});

test('a stale conversation write returns a 409 without replaying the skill', async () => {
  const boundary = fakePersistence();
  let session: ConversationSession | undefined;
  let skillCalls = 0;
  let saveAttempts = 0;
  const service = new ConversationService({
    persistence: {
      async create(created) {
        session = created;
        return created;
      },
      async get() {
        return session ?? null;
      },
      async save() {
        saveAttempts++;
        throw new ConversationFailure('CONVERSATION_WRITE_CONFLICT');
      },
    },
    understanding: new UnderstandingService(),
    skills: {
      async execute({ skillId }) {
        skillCalls++;
        return { status: 'completed', skillId, skillVersion: 1, runId: 'run-conflict' };
      },
    },
    defaultSkillId: 't.conflict',
  });
  const created = await service.create('p', 'a', 'private');

  const res = await handleConversationMessage({ boundary, service }, 'p', 'a', created.id, { text: 'hi' });

  assert.ok(!res.ok);
  assert.equal(res.status, 409);
  assert.equal(res.error.category, 'conversation');
  assert.equal(res.error.code, 'CONVERSATION_WRITE_CONFLICT');
  assert.equal(skillCalls, 1);
  assert.equal(saveAttempts, 1);
});

// ── A+: generic stage timings ───────────────────────────────────────────────

test('A+: model and knowledge calls are counted and timed (generic, at the boundary)', async () => {
  const persistence = fakePersistence();
  let modelCalls = 0;
  const skill = skillWith({
    id: 't.timed',
    model: true,
    knowledge: true,
    execute: async (ctx) => {
      await ctx.knowledge!.resolveSources(['kitab']);
      await ctx.knowledge!.search({ query: 'صفرة', topK: 3 });
      await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'q1' });
      const out = await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'q2', maxOutputTokens: 100 });
      return { trace: { notes: ['ok'] }, text: (out as { text: string }).text };
    },
  });
  const runtime = runtimeFor(skill, {
    persistence,
    modelGateway: fakeGateway(async () => {
      modelCalls += 1;
      return { text: 'answer', provider: 'openrouter', model: 'test/model', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, costUsd: 0.001 } };
    }),
    knowledge: () => ({
      async search() {
        return [];
      },
      async resolveSources() {
        return [];
      },
      async adjacent() {
        return [];
      },
    }),
  });

  const logs = captureLogs();
  let res: Awaited<ReturnType<typeof runtime.execute>>;
  try {
    res = await runtime.execute({ ...input, skillId: 't.timed' });
  } finally {
    logs.restore();
  }

  assert.equal(res.status, 'completed');
  const t = res.trace?.timings;
  assert.ok(t, 'timings attached to the trace');
  assert.equal(t!.model_call_count, 2);
  assert.equal(t!.model_calls.length, 2);
  assert.equal(t!.model_calls[0].call_index, 1);
  assert.equal(t!.model_calls[1].call_index, 2);
  assert.equal(t!.model_calls.every((c) => c.status === 'success' && c.timeout === false), true);
  assert.equal(t!.model_calls.every((c) => typeof c.duration_ms === 'number' && c.duration_ms >= 0), true);
  assert.equal(t!.model_calls[0].provider, 'openrouter');
  assert.equal(t!.model_calls[0].model, 'test/model');
  assert.equal(t!.model_calls[0].input_tokens, 10);
  assert.equal(t!.model_calls[0].output_tokens, 20);
  assert.ok(t!.model_total_ms >= 0);

  assert.equal(t!.knowledge_call_count, 2);
  assert.deepEqual(t!.knowledge_calls.map((c) => c.operation), ['resolveSources', 'search']);
  assert.equal(t!.knowledge_calls.every((c) => c.status === 'success'), true);
  assert.ok(t!.knowledge_total_ms >= 0);

  assert.ok(t!.total_ms >= 0 && t!.skill_ms >= 0 && t!.context_ms >= 0 && t!.persistence_ms >= 0);

  // The run row now carries the previously-always-null provider/model/usage columns.
  const run = persistence.runs[res.runId!];
  assert.equal(run.providerKey, 'openrouter');
  assert.equal(run.modelName, 'test/model');
  assert.equal(run.usage?.totalTokens, 60);
  assert.equal(modelCalls, 2);

  // …and the same breakdown is logged once per run.
  const logged = turnLog(logs.lines);
  assert.equal(logged.model_call_count, 2);
  assert.equal(logged.knowledge_call_count, 2);
});

test('A+ : a FAILED execution keeps the timings it already measured (#11)', async () => {
  const persistence = fakePersistence();
  const skill = skillWith({
    id: 't.timed-fail',
    model: true,
    knowledge: true,
    execute: async (ctx) => {
      await ctx.knowledge!.search({ query: 'q' });
      await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'ok-call' });
      await ctx.model!.generateText({ workload: 'knowledge_answer', message: 'timed-out-call' });
      return { trace: { notes: ['unreachable'] } };
    },
  });
  let call = 0;
  const runtime = runtimeFor(skill, {
    persistence,
    modelGateway: fakeGateway(async () => {
      call += 1;
      if (call === 2) throw providerError('chat completion timed out', 'PROVIDER_CHAT_TIMEOUT', { timeoutMs: 300_000 });
      return { text: 'first answer', provider: 'openrouter', model: 'test/model', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } };
    }),
    knowledge: () => ({
      async search() {
        return [];
      },
      async resolveSources() {
        return [];
      },
      async adjacent() {
        return [];
      },
    }),
  });

  const logs = captureLogs();
  try {
    await assert.rejects(() => runtime.execute({ ...input, skillId: 't.timed-fail' }));
  } finally {
    logs.restore();
  }

  const logged = turnLog(logs.lines);
  assert.equal(logged.outcome, 'failed');
  assert.equal(logged.errorCategory, 'provider');
  assert.equal(logged.model_call_count, 2, 'the completed call AND the failed call are both retained');
  assert.equal(logged.model_calls[0].status, 'success');
  assert.equal(typeof logged.model_calls[0].duration_ms, 'number');
  assert.equal(logged.model_calls[0].input_tokens, 5);
  assert.equal(logged.model_calls[1].timeout, true);
  assert.equal(logged.model_calls[1].status, 'timeout');
  assert.equal(logged.knowledge_call_count, 1);
  assert.equal(logged.knowledge_calls[0].operation, 'search');
  assert.ok(logged.skill_ms >= 0 && logged.total_ms >= logged.skill_ms);
  assert.equal(logged.finalized, true, 'the failed run is still finalized');

  const run = Object.values(persistence.runs)[0];
  assert.equal(run.status, 'failed');
  // Partial model usage measured before the failure is retained, not discarded.
  assert.equal(run.usage?.totalTokens, 12);
});
