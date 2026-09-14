import test from 'node:test';
import assert from 'node:assert/strict';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';
import { createSourceStorage, isSourceType } from '../src/platform/provider/source.storage.ts';

/**
 * Supabase-like in-memory DB fake for the `sources` table.
 * Each `from()` starts an independent query chain; terminal ops read current filters.
 */
function newQuery(sources: Array<Record<string, unknown>>) {
  const filters: Array<{ op: 'eq' | 'neq'; col: string; val: unknown }> = [];
  const matches = (r: Record<string, unknown>) =>
    filters.every((f) => (f.op === 'eq' ? r[f.col] === f.val : r[f.col] !== f.val));

  const q = {
    select() {
      filters.length = 0;
      return q;
    },
    eq(col: string, v: unknown) {
      filters.push({ op: 'eq', col, val: v });
      return q;
    },
    neq(col: string, v: unknown) {
      filters.push({ op: 'neq', col, val: v });
      return q;
    },
    maybeSingle: async () => {
      const row = sources.find(matches);
      return { data: (row as Record<string, unknown>) ?? null, error: null };
    },
    limit: async () => ({ data: sources.filter(matches), error: null }),
    insert(vals: Record<string, unknown>) {
      sources.push({ ...vals });
      return q;
    },
    update(vals: Record<string, unknown>) {
      const r = sources.find(matches);
      if (r) Object.assign(r, vals);
      return q;
    },
    delete() {
      const i = sources.findIndex(matches);
      if (i >= 0) sources.splice(i, 1);
      return q;
    },
  };
  return q;
}

function fakeDb(): { db: SupabaseDatabase; sources: Array<Record<string, unknown>> } {
  const sources: Array<Record<string, unknown>> = [];
  const db = {
    from() {
      return newQuery(sources);
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { db: db as unknown as SupabaseDatabase, sources };
}

test('isSourceType: the canonical Knowledge Intake V1 source types are valid', () => {
  for (const t of ['url', 'file', 'text', 'github', 'google_drive'] as const) {
    assert.equal(isSourceType(t), true, `${t} must be a valid source type`);
  }
  assert.equal(isSourceType('connector'), false);
  assert.equal(isSourceType(''), false);
  assert.equal(isSourceType(undefined), false);
});

test('source storage: create -> registered; list excludes archived; archive terminal; get still works', async () => {
  const { db, sources } = fakeDb();
  const storage = createSourceStorage(db);
  const created = await storage.create({ projectId: 'p1', sourceType: 'url', title: 'T', externalUri: 'https://x.dev', createdBySubject: 'act' });
  assert.equal(created.status, 'registered');
  assert.equal(sources.length, 1);

  assert.equal((await storage.listByProject('p1', false)).length, 1);

  const archived = await storage.archive('p1', created.id);
  assert.equal(archived?.status, 'archived');
  assert.ok(archived?.archivedAt);

  assert.equal((await storage.listByProject('p1', false)).length, 0);
  assert.equal((await storage.listByProject('p1', true)).length, 1);
  assert.equal((await storage.getByProject('p1', created.id))?.status, 'archived');
});

test('source storage: update only touches editable metadata', async () => {
  const { db } = fakeDb();
  const storage = createSourceStorage(db);
  const created = await storage.create({ projectId: 'p1', sourceType: 'url', title: 'T', externalUri: 'https://x.dev', createdBySubject: 'act' });
  const updated = await storage.update('p1', created.id, { title: 'T2', description: 'd' });
  assert.equal(updated?.title, 'T2');
  assert.equal(updated?.description, 'd');
  assert.equal(updated?.externalUri, 'https://x.dev'); // unchanged
});