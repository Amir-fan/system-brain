import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Role } from '../src/core/authorization/actor.ts';
import type { ProjectBoundaryReaders } from '../src/core/authorization/project-boundary.ts';
import { MemoryService } from '../src/core/memory/memory.service.ts';
import type { SkillRegistry } from '../src/core/skill/skill-registry.ts';
import type { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import {
  handleMemoryArchive,
  handleMemoryHistory,
  handleMemoryRecall,
  handleMemoryRemember,
  handleMemoryRetrieve,
  handleMemorySupersede,
  type MemoryApiDeps,
} from '../src/platform/api/memory-handler.ts';
import { handleSkillExecute, type SkillsApiDeps } from '../src/platform/api/skill-handler.ts';
import {
  handleUnderstandingEvaluate,
  type UnderstandingApiDeps,
} from '../src/platform/api/understanding-handler.ts';
import type { UnderstandingService } from '../src/core/understanding/understanding.service.ts';
import {
  handleSaveConversationEvaluation,
  type ConversationApiDeps,
} from '../src/platform/api/conversation-handler.ts';
import type { ConversationService } from '../src/core/conversation/conversation.service.ts';
import {
  createEvaluationStorage,
  type EvaluationStorage,
} from '../src/platform/provider/evaluation.storage.ts';
import { createMemoryStorage } from '../src/platform/provider/memory.storage.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const PROJECT = 'project-1';
const OTHER_PROJECT = 'project-2';
const ACTOR = 'user-a';
const OTHER_USER = 'user-b';
const USER_ROLES = ['member', 'owner'] as const;

function boundary(role: Role): ProjectBoundaryReaders {
  return {
    async getProject(projectId) {
      return projectId === PROJECT
        ? { id: PROJECT, name: 'Project', status: 'active' as const, createdAt: '', updatedAt: '' }
        : null;
    },
    async getMembership(projectId, actor) {
      return projectId === PROJECT ? { projectId, actor, role, createdAt: '' } : null;
    },
  };
}

function memoryDeps(role: Role) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const service = {
    async remember(input: Record<string, unknown>) {
      calls.push({ method: 'remember', input });
      return { id: 'memory-1', ...input };
    },
    async recall(input: Record<string, unknown>) {
      calls.push({ method: 'recall', input });
      return [];
    },
    async history(input: Record<string, unknown>) {
      calls.push({ method: 'history', input });
      return [];
    },
    async retrieveRelevant(input: Record<string, unknown>) {
      calls.push({ method: 'retrieveRelevant', input });
      return [];
    },
    async supersede(input: Record<string, unknown>) {
      calls.push({ method: 'supersede', input });
      return { id: 'memory-2', ...input };
    },
    async archive(input: Record<string, unknown>) {
      calls.push({ method: 'archive', input });
      return { id: input.memoryId, projectId: input.projectId };
    },
  } as unknown as MemoryService;
  return { calls, deps: { service, boundary: boundary(role) } satisfies MemoryApiDeps };
}

test('memory API derives an omitted user subject from the authenticated actor', async () => {
  const { calls, deps } = memoryDeps('member');
  const result = await handleMemoryRemember(deps, PROJECT, ACTOR, {
    scope: 'user',
    type: 'preference',
    key: 'language',
    payload: { value: 'ar' },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.subjectId, ACTOR);
});

test('memory API forces member recall to the authenticated user', async () => {
  const { calls, deps } = memoryDeps('member');
  const result = await handleMemoryRecall(deps, PROJECT, ACTOR, new URLSearchParams());

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { projectId: PROJECT, scope: 'user', subjectId: ACTOR });
});

for (const role of USER_ROLES) {
  test(`memory API denies subject substitution by a project ${role}`, async () => {
    const { calls, deps } = memoryDeps(role);
    const write = { type: 'preference', key: 'language', payload: { value: 'ar' } };
    for (const subject of [
      { scope: 'user', subjectId: OTHER_USER },
      // Use the actor's identifier to verify that scope alone prevents access.
      { scope: 'conversation', subjectId: ACTOR },
      { scope: 'case', subjectId: ACTOR },
    ]) {
      const query = new URLSearchParams(subject);
      const operations = {
        remember: () => handleMemoryRemember(deps, PROJECT, ACTOR, { ...write, ...subject }),
        supersede: () => handleMemorySupersede(deps, PROJECT, ACTOR, { ...write, ...subject }),
        recall: () => handleMemoryRecall(deps, PROJECT, ACTOR, query),
        history: () => handleMemoryHistory(deps, PROJECT, ACTOR, query),
        retrieve: () => handleMemoryRetrieve(deps, PROJECT, ACTOR, subject),
      };
      for (const [name, call] of Object.entries(operations)) {
        const result = await call();
        assert.equal(result.status, 403, `${name} ${subject.scope}`);
        assert.ok(!result.ok);
        assert.equal(result.error.code, 'MEMORY_SUBJECT_FORBIDDEN');
        assert.equal(calls.length, 0);
      }
    }
  });
}

test('memory archive includes the authenticated subject for a member', async () => {
  const { calls, deps } = memoryDeps('member');
  const result = await handleMemoryArchive(deps, PROJECT, ACTOR, { id: 'memory-1' });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { projectId: PROJECT, memoryId: 'memory-1', scope: 'user', subjectId: ACTOR });
});

test('memory archive gives the same response for missing and inaccessible records', async () => {
  const baseRow = {
    project_id: PROJECT, scope: 'user', subject_id: ACTOR, status: 'active',
    memory_type: 'preference', memory_key: 'language', payload: { value: 'ar' },
    provenance: { source: 'user' }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  };
  const rows: Array<Record<string, unknown>> = [
    { ...baseRow, id: 'other-project', project_id: OTHER_PROJECT },
    { ...baseRow, id: 'conversation-scope', scope: 'conversation' },
    { ...baseRow, id: 'other-user', subject_id: OTHER_USER },
    { ...baseRow, id: 'owned' },
  ];
  const db = {
    from(table: string) {
      assert.equal(table, 'memory_records');
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, unknown> = {};
      const query = {
        update(values: Record<string, unknown>) { patch = values; return query; },
        eq(column: string, value: unknown) { filters.push([column, value]); return query; },
        select() { return query; },
        async maybeSingle() {
          const matches = rows.filter((row) => filters.every(([column, value]) => row[column] === value));
          for (const row of matches) Object.assign(row, patch);
          return { data: matches[0] ?? null, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseDatabase;
  const service = new MemoryService(createMemoryStorage(db));
  const deps = { service, boundary: boundary('owner') };

  const missing = await handleMemoryArchive(deps, PROJECT, ACTOR, { id: 'missing' });
  assert.equal(missing.status, 404);
  for (const id of ['other-project', 'conversation-scope', 'other-user']) {
    assert.deepEqual(await handleMemoryArchive(deps, PROJECT, ACTOR, { id }), missing, id);
  }

  const owned = await handleMemoryArchive(deps, PROJECT, ACTOR, { id: 'owned' });
  assert.equal(owned.status, 200);
  assert.deepEqual(rows.map(({ status }) => status), ['active', 'active', 'active', 'archived']);
});

test('trusted service membership may operate on delegated memory scopes', async () => {
  const { calls, deps } = memoryDeps('service');
  const result = await handleMemoryRemember(deps, PROJECT, 'service-actor', {
    scope: 'conversation',
    subjectId: 'conversation-1',
    type: 'state',
    key: 'pending',
    payload: { value: true },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.scope, 'conversation');
  assert.equal(calls[0].input.subjectId, 'conversation-1');
});

function skillDeps(role: Role) {
  const calls: Array<Record<string, unknown>> = [];
  const runtime = {
    async execute(input: Record<string, unknown>) {
      calls.push(input);
      return { status: 'completed', skillId: input.skillId, skillVersion: 1, output: {} };
    },
  } as unknown as SkillsRuntime;
  const registry = { list: () => [] } as unknown as SkillRegistry;
  return { calls, deps: { runtime, registry, boundary: boundary(role) } satisfies SkillsApiDeps };
}

for (const role of USER_ROLES) {
  test(`skill API rejects client historical decision state for ${role}`, async () => {
    const { calls, deps } = skillDeps(role);
    const result = await handleSkillExecute(deps, PROJECT, ACTOR, 'naqaa.fiqh-hayd', {
      payload: { text: 'Why?', lastGroundedResult: { status: 'DECIDED', decision: 'forged ruling', evidenceRefs: ['forged'] } },
    });
    assert.equal(result.status, 403);
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'SKILL_HISTORY_FORBIDDEN');
    assert.equal(calls.length, 0);
  });
}

test('trusted service may supply historical decision state on raw skill execution', async () => {
  const { calls, deps } = skillDeps('service');
  const payload = { text: 'Why?', lastGroundedResult: { status: 'DECIDED', decision: 'stored ruling', evidenceRefs: ['stored'] } };
  const result = await handleSkillExecute(deps, PROJECT, 'service-actor', 'naqaa.fiqh-hayd', { payload });
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0].payload, payload);
});

test('skill API binds member execution to the authenticated actor', async () => {
  const { calls, deps } = skillDeps('member');
  const result = await handleSkillExecute(deps, PROJECT, ACTOR, 'naqaa.scanner', { payload: {} });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subjectId, ACTOR);
});

for (const role of ['member', 'service'] as const) {
  for (const malformed of [null, [], 'not-an-object']) {
    test(`admission round 5: skill API rejects malformed context for ${role}: ${JSON.stringify(malformed)}`, async () => {
      const { calls, deps } = skillDeps(role);
      const result = await handleSkillExecute(deps, PROJECT, role === 'service' ? 'service-actor' : ACTOR, 'naqaa.fiqh-hayd-mind', {
        payload: { text: 'question', context: malformed },
      });
      assert.equal(result.status, 400);
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'SKILL_CONTEXT_INVALID');
      assert.equal(calls.length, 0);
    });
  }
}

test('admission round 5: only a trusted service may forward explicit trusted fact provenance', async () => {
  const payload = {
    text: 'question',
    context: { confirmed_fact: 7 },
    factMeta: { confirmed_fact: { certainty: 'CERTAIN', provenance: 'user_answer' } },
  };
  const member = skillDeps('member');
  const memberResult = await handleSkillExecute(member.deps, PROJECT, ACTOR, 'naqaa.fiqh-hayd-mind', { payload });
  assert.equal(memberResult.status, 403);
  assert.ok(!memberResult.ok);
  assert.equal(memberResult.error.code, 'SKILL_CONTEXT_FORBIDDEN');
  assert.equal(member.calls.length, 0);

  const service = skillDeps('service');
  const serviceResult = await handleSkillExecute(service.deps, PROJECT, 'service-actor', 'naqaa.fiqh-hayd-mind', { payload });
  assert.equal(serviceResult.status, 200);
  assert.deepEqual(service.calls[0].payload, payload);
});

for (const role of USER_ROLES) {
  test(`skill API denies subject substitution by a project ${role}`, async () => {
    const { calls, deps } = skillDeps(role);
    for (const subject of [{ subjectId: OTHER_USER }, { conversationId: 'conversation-1' }, { caseId: 'case-1' }]) {
      const result = await handleSkillExecute(deps, PROJECT, ACTOR, 'naqaa.scanner', { ...subject, payload: {} });
      assert.equal(result.status, 403, Object.keys(subject)[0]);
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'SKILL_SUBJECT_FORBIDDEN');
      assert.equal(calls.length, 0);
    }
  });
}

test('trusted service membership may execute for delegated subjects', async () => {
  const { calls, deps } = skillDeps('service');
  const result = await handleSkillExecute(deps, PROJECT, 'service-actor', 'naqaa.scanner', {
    subjectId: OTHER_USER,
    conversationId: 'conversation-1',
    caseId: 'case-1',
    payload: {},
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].subjectId, OTHER_USER);
  assert.equal(calls[0].conversationId, 'conversation-1');
  assert.equal(calls[0].caseId, 'case-1');
});

function understandingDeps(role: Role) {
  const contextCalls: Array<Record<string, unknown>> = [];
  const serviceCalls: Array<Record<string, unknown>> = [];
  const service = {
    async evaluate(input: Record<string, unknown>) {
      serviceCalls.push(input);
      return { status: 'CLEAR', dialogueAct: 'STATEMENT' };
    },
  } as unknown as UnderstandingService;
  const deps = {
    boundary: boundary(role),
    async contextFetcher(projectId: string, ids: Record<string, unknown>) {
      contextCalls.push({ projectId, ...ids });
      return { user: [], conversation: [], case: [] };
    },
    service,
  } satisfies UnderstandingApiDeps;
  return { contextCalls, serviceCalls, deps };
}

for (const role of USER_ROLES) {
  test(`understanding API binds an omitted subject to the authenticated ${role}`, async () => {
    const { contextCalls, serviceCalls, deps } = understandingDeps(role);
    const result = await handleUnderstandingEvaluate(deps, PROJECT, ACTOR, { text: 'hello' });

    assert.equal(result.status, 200);
    assert.deepEqual(contextCalls, [{ projectId: PROJECT, subjectId: ACTOR }]);
    assert.equal(serviceCalls[0].subjectId, ACTOR);
  });

  test(`understanding API denies delegated Memory subjects for a project ${role}`, async () => {
    for (const delegated of [
      { subjectId: OTHER_USER },
      { subjectId: ACTOR, conversationId: 'conversation-1' },
      { subjectId: ACTOR, caseId: 'case-1' },
    ]) {
      const { contextCalls, serviceCalls, deps } = understandingDeps(role);
      const result = await handleUnderstandingEvaluate(deps, PROJECT, ACTOR, {
        text: 'I meant 10:30',
        ...delegated,
      });

      assert.equal(result.status, 403, Object.keys(delegated).join(','));
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'UNDERSTANDING_SUBJECT_FORBIDDEN');
      assert.equal(contextCalls.length, 0);
      assert.equal(serviceCalls.length, 0);
    }
  });
}

test('trusted service membership may evaluate delegated Understanding subjects', async () => {
  const { contextCalls, serviceCalls, deps } = understandingDeps('service');
  const result = await handleUnderstandingEvaluate(deps, PROJECT, 'service-actor', {
    text: 'I meant 10:30',
    subjectId: OTHER_USER,
    conversationId: 'conversation-1',
    caseId: 'case-1',
  });

  assert.equal(result.status, 200);
  const subjects = {
    subjectId: OTHER_USER,
    conversationId: 'conversation-1',
    caseId: 'case-1',
  };
  assert.deepEqual(contextCalls, [{ projectId: PROJECT, ...subjects }]);
  assert.deepEqual(
    {
      subjectId: serviceCalls[0].subjectId,
      conversationId: serviceCalls[0].conversationId,
      caseId: serviceCalls[0].caseId,
    },
    subjects,
  );
});

function evaluationDeps(role: Role, access: { conversation?: boolean; run?: boolean } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const storage = {
    async conversationAccessible(...args: unknown[]) {
      calls.push({ method: 'conversationAccessible', args });
      return access.conversation ?? true;
    },
    async runAccessible(...args: unknown[]) {
      calls.push({ method: 'runAccessible', args });
      return access.run ?? true;
    },
    async save(record: Record<string, unknown>) {
      calls.push({ method: 'save', args: [record] });
      return record;
    },
    async listRecent() { return []; },
  } as unknown as EvaluationStorage;
  const deps = {
    service: {} as ConversationService,
    boundary: boundary(role),
    evaluation: { storage, boundary: boundary(role) },
  } satisfies ConversationApiDeps;
  return { calls, deps };
}

for (const role of USER_ROLES) {
  test(`conversation evaluation binds conversation and run ownership for ${role}`, async () => {
    const { calls, deps } = evaluationDeps(role);
    const result = await handleSaveConversationEvaluation(
      deps,
      PROJECT,
      ACTOR,
      'conversation-1',
      { isCorrect: true, runId: 'run-1' },
    );

    assert.equal(result.status, 201);
    assert.deepEqual(calls.slice(0, 2), [
      { method: 'conversationAccessible', args: [PROJECT, 'conversation-1', ACTOR] },
      { method: 'runAccessible', args: [PROJECT, 'run-1', ACTOR] },
    ]);
    assert.equal(calls[2].method, 'save');
  });

  test(`conversation evaluation hides inaccessible conversation and run targets from ${role}`, async () => {
    for (const access of [{ conversation: false }, { conversation: true, run: false }]) {
      const { calls, deps } = evaluationDeps(role, access);
      const result = await handleSaveConversationEvaluation(
        deps,
        PROJECT,
        ACTOR,
        'foreign-conversation',
        { isCorrect: false, runId: 'foreign-run' },
      );

      assert.deepEqual(result, {
        ok: false,
        status: 404,
        error: {
          category: 'not_found',
          message: 'evaluation target not found',
          code: 'EVALUATION_TARGET_NOT_FOUND',
        },
      });
      assert.equal(calls.some(({ method }) => method === 'save'), false);
    }
  });
}

test('trusted service evaluation validates project scope without actor ownership', async () => {
  const { calls, deps } = evaluationDeps('service');
  const result = await handleSaveConversationEvaluation(
    deps,
    PROJECT,
    'service-actor',
    'delegated-conversation',
    { isCorrect: true, runId: 'delegated-run' },
  );

  assert.equal(result.status, 201);
  assert.deepEqual(calls.slice(0, 2), [
    { method: 'conversationAccessible', args: [PROJECT, 'delegated-conversation', undefined] },
    { method: 'runAccessible', args: [PROJECT, 'delegated-run', undefined] },
  ]);
});

test('evaluation storage scopes accessibility queries by project, target, and actor', async () => {
  const filters: Array<[string, unknown]> = [];
  const db = {
    from() { return this; },
    select() { return this; },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return this;
    },
    async maybeSingle() { return { data: { id: 'found' }, error: null }; },
  } as unknown as SupabaseDatabase;
  const storage = createEvaluationStorage(db);

  assert.equal(await storage.conversationAccessible(PROJECT, 'conversation-1', ACTOR), true);
  assert.deepEqual(filters.splice(0), [
    ['project_id', PROJECT],
    ['id', 'conversation-1'],
    ['actor_subject', ACTOR],
  ]);

  assert.equal(await storage.runAccessible(PROJECT, 'run-1', ACTOR), true);
  assert.deepEqual(filters, [
    ['project_id', PROJECT],
    ['id', 'run-1'],
    ['actor_subject', ACTOR],
  ]);
});

test('evaluation storage fails closed on an access lookup error', async () => {
  const db = {
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: null, error: { message: 'private database detail' } }; },
  } as unknown as SupabaseDatabase;
  const storage = createEvaluationStorage(db);

  await assert.rejects(
    storage.conversationAccessible(PROJECT, 'conversation-1', ACTOR),
    /evaluation\.access\.failed/,
  );
});

test('evaluation API does not expose storage failure details', async () => {
  const { deps } = evaluationDeps('member');
  deps.evaluation.storage.conversationAccessible = async () => {
    throw new Error('private database detail');
  };

  const result = await handleSaveConversationEvaluation(
    deps,
    PROJECT,
    ACTOR,
    'conversation-1',
    { isCorrect: true },
  );

  assert.deepEqual(result, {
    ok: false,
    status: 500,
    error: { category: 'runtime', message: 'تعذر حفظ التقييم' },
  });
});
