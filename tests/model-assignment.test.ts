import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';
import {
  createModelAssignmentStorage,
  createModelAssignmentResolver,
  isWorkloadKey,
  MissingAssignmentError,
} from '../src/platform/provider/model-assignment.ts';

function fakeDb(initial: Array<Record<string, unknown>> = []) {
  const rows = JSON.parse(JSON.stringify(initial)) as Array<Record<string, unknown>>;
  let chain: Record<string, unknown> = {};
  const api = {
    from() {
      chain = { op: 'from' };
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
      const row = rows.find((r) => (chain.eqCol ? r[chain.eqCol as string] === chain.eqVal : true));
      return { data: (row as Record<string, unknown>) ?? null, error: null };
    },
    update(vals: Record<string, unknown>) {
      const r = rows.find((x) => x[chain.eqCol as string] === chain.eqVal);
      if (r) Object.assign(r, vals);
      chain = { ...chain, op: 'update' };
      return api;
    },
    insert(vals: Record<string, unknown>) {
      rows.push(vals);
      chain = { ...chain, op: 'insert' };
      return api;
    },
    delete() {
      const idx = rows.findIndex((r) => r[chain.eqCol as string] === chain.eqVal);
      if (idx >= 0) rows.splice(idx, 1);
      chain = { ...chain, op: 'delete' };
      return api;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return api as unknown as SupabaseDatabase;
}

test('resolver: valid workload + active assignment returns model id', async () => {
  const storage = createModelAssignmentStorage(fakeDb([
    { workload_key: 'source_analysis', provider_key: 'openrouter', model_id: 'openai/gpt-4o-mini', is_active: true },
  ]));
  const resolver = createModelAssignmentResolver(storage);
  const resolved = await resolver.resolve({ profile: 'source_analysis' });
  assert.equal(resolved.modelId, 'openai/gpt-4o-mini');
  assert.equal(resolved.providerKey, 'openrouter');
});

test('resolver: no assignment throws MissingAssignmentError (no fallback)', async () => {
  const storage = createModelAssignmentStorage(fakeDb());
  const resolver = createModelAssignmentResolver(storage);
  await assert.rejects(() => resolver.resolve({ profile: 'source_analysis' }), MissingAssignmentError);
});

test('resolver: inactive assignment throws MissingAssignmentError', async () => {
  const storage = createModelAssignmentStorage(fakeDb([
    { workload_key: 'chat_assistant', provider_key: 'openrouter', model_id: 'm', is_active: false },
  ]));
  const resolver = createModelAssignmentResolver(storage);
  await assert.rejects(() => resolver.resolve({ profile: 'chat_assistant' }), MissingAssignmentError);
});

test('resolver: unknown/invalid workload throws MissingAssignmentError', async () => {
  const storage = createModelAssignmentStorage(fakeDb());
  const resolver = createModelAssignmentResolver(storage);
  await assert.rejects(() => resolver.resolve({ profile: 'not-a-workload' }), MissingAssignmentError);
});

test('storage: upsert creates, then update changes model; get/remove work', async () => {
  const db = fakeDb();
  const storage = createModelAssignmentStorage(db);
  const created = await storage.upsert('source_analysis', 'model-a');
  assert.equal(created.modelId, 'model-a');
  assert.equal(created.providerKey, 'openrouter');
  assert.equal((await storage.get('source_analysis'))?.modelId, 'model-a');
  await storage.upsert('source_analysis', 'model-b');
  assert.equal((await storage.get('source_analysis'))?.modelId, 'model-b');
  await storage.remove('source_analysis');
  assert.equal(await storage.get('source_analysis'), null);
});

test('isWorkloadKey accepts only canonical keys', () => {
  for (const ok of ['source_analysis', 'chat_assistant', 'vision_scan', 'summarization', 'embeddings']) {
    assert.equal(isWorkloadKey(ok), true);
  }
  assert.equal(isWorkloadKey('source-analysis'), false);
  assert.equal(isWorkloadKey('smart-scan'), false);
});