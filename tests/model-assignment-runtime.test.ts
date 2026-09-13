import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeService } from '../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../src/core/capability/capability-registry.ts';
import { platformAiCompletion } from '../src/core/capability/ai-echo.ts';
import { createSupabaseRuntimePersistence } from '../src/platform/supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';
import {
  createModelAssignmentStorage,
  createModelAssignmentResolver,
} from '../src/platform/provider/model-assignment.ts';
import type { ModelAssignmentStorage } from '../src/platform/provider/model-assignment.ts';
import { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';
import { ResolvingModelGateway } from '../src/platform/model-gateway/resolving-gateway.ts';
import type { ModelGatewayInput } from '../src/core/model-gateway/model-gateway.ts';

/** In-memory Supabase-shaped DB backing both run + assignment persistence. */
function fakeDb() {
  const state = {
    runs: [] as Array<Record<string, unknown>>,
    model_assignments: [] as Array<Record<string, unknown>>,
    project_memberships: [] as Array<Record<string, unknown>>,
    projects: new Map<string, Record<string, unknown>>([['p1', { id: 'p1', name: 'p', status: 'active' }]]),
  };
  let chain: Record<string, unknown> = { table: '' };
  const api = {
    from(table: string) {
      chain = { table, op: 'from' };
      return api;
    },
    select() {
      chain = { ...chain, op: 'select' };
      return api;
    },
    eq(col: string, val: unknown) {
      chain = { ...chain, eqCol: col, eqVal: val };
      return api;
    },
    maybeSingle: async () => {
      const table = chain.table as 'runs' | 'model_assignments' | 'project_memberships' | 'projects';
      if (table === 'projects') {
        const p = state.projects.get(String(chain.eqVal ?? ''));
        return { data: p ?? null, error: null };
      }
      const rows = state[table] as Array<Record<string, unknown>>;
      const row = (rows ?? []).find((r) => (chain.eqCol ? r[chain.eqCol as string] === chain.eqVal : true));
      return { data: row ?? null, error: null };
    },
    update(vals: Record<string, unknown>) {
      const rows = state[chain.table as 'runs' | 'model_assignments' | 'project_memberships'] as Array<Record<string, unknown>> | undefined;
      const r = (rows ?? []).find((x) => x[chain.eqCol as string] === chain.eqVal);
      if (r) Object.assign(r, vals);
      chain = { ...chain, op: 'update' };
      return api;
    },
    insert(vals: Record<string, unknown>) {
      (state[chain.table as 'runs' | 'model_assignments' | 'project_memberships'] as Array<Record<string, unknown>>).push(vals);
      chain = { ...chain, op: 'insert' };
      return api;
    },
    delete() {
      const rows = state[chain.table as 'runs' | 'model_assignments'] as Array<Record<string, unknown>> | undefined;
      const idx = (rows ?? []).findIndex((r) => r[chain.eqCol as string] === chain.eqVal);
      if (rows && idx >= 0) rows.splice(idx, 1);
      chain = { ...chain, op: 'delete' };
      return api;
    },
    rpc: async () => ({ data: null, error: null }),
  } as unknown as SupabaseDatabase;
  return { db: api, state };
}

test('runtime: capability workload resolves to assigned model and Run persists it (fake gateway)', async () => {
  const { db, state } = fakeDb();
  state.project_memberships.push({ project_id: 'p1', actor_subject: 'a1', role: 'owner' });

  // assignment: source_analysis -> model-x
  const assignmentStorage = createModelAssignmentStorage(db);
  const resolver = createModelAssignmentResolver(assignmentStorage);
  await assignmentStorage.upsert('source_analysis', 'model-x');

  // captured model passed to the provider adapter
  let adapterModel = '';
  const mkAdapter = () => ({
    generateText: async (input: ModelGatewayInput) => {
      adapterModel = input.modelId ?? '';
      return { text: 'ok', provider: 'openrouter', model: input.modelId ?? '', usage: { totalTokens: 4 }, latencyMs: 3 };
    },
  }) as unknown as OpenRouterGateway;

  const gateway = new ResolvingModelGateway(mkAdapter() as never, resolver);
  const registry = new MapCapabilityRegistry();
  registry.register('platform.ai-completion', platformAiCompletion(gateway));
  const runtime = new RuntimeService(createSupabaseRuntimePersistence(db), registry);

  const result = await runtime.execute({
    projectId: 'p1',
    actor: 'a1',
    capability: 'platform.ai-completion',
    input: { message: 'hi', workload: 'source_analysis' },
  });

  assert.equal((result as { status: string }).status, 'completed');
  assert.equal(adapterModel, 'model-x'); // resolver selected the assigned model
  const run2 = state.runs[0] as Record<string, unknown>;
  assert.equal(run2.provider_key, 'openrouter');
  assert.equal(run2.model_name, 'model-x');
});

test('runtime: no assignment -> capability invocation fails (normalized missing-assignment), run fails', async () => {
  const { db, state } = fakeDb();
  state.project_memberships.push({ project_id: 'p1', actor_subject: 'a1', role: 'owner' });
  const assignmentStorage = createModelAssignmentStorage(db);
  const resolver = createModelAssignmentResolver(assignmentStorage);
  const gateway = new ResolvingModelGateway({ generateText: async () => ({ text: '', provider: 'openrouter' }) } as never, resolver);
  const registry = new MapCapabilityRegistry();
  registry.register('platform.ai-completion', platformAiCompletion(gateway));
  const runtime = new RuntimeService(createSupabaseRuntimePersistence(db), registry);

  const result = await runtime.execute({
    projectId: 'p1',
    actor: 'a1',
    capability: 'platform.ai-completion',
    input: { message: 'hi', workload: 'source_analysis' },
  });
  // resolver threw MissingAssignmentError inside the capability -> run failed (never reached provider)
  assert.equal((result as { status: string }).status, 'failed');
});