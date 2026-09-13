import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  liveSupabase,
  createLiveProject,
  createLiveMembership,
  setLiveProjectStatus,
  cleanLive,
  countLiveRuns,
} from './supabase.helpers.ts';
import type { SupabaseDatabase } from '../../src/platform/supabase/supabase.persistence.ts';
import { createSupabaseRuntimePersistence } from '../../src/platform/supabase/supabase.persistence.ts';
import { RuntimeService } from '../../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../../src/core/capability/capability-registry.ts';

const hasServerKey = Boolean(process.env.SUPABASE_SERVER_KEY && process.env.SUPABASE_URL);
let db: SupabaseDatabase;
let projectA = '';
let projectB = '';
let created: string[] = [];
const ACTOR_A = 'k0sb-actor-a';
const TAG = `k0sb-${Date.now()}`;

function throwingRuntime(): RuntimeService {
  const reg = new MapCapabilityRegistry();
  reg.register('platform.echo', async () => {
    throw new Error('boom');
  });
  return new RuntimeService(createSupabaseRuntimePersistence(db), reg);
}

function liveRuntime(_db?: SupabaseDatabase): RuntimeService {
  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => input);
  return new RuntimeService(createSupabaseRuntimePersistence(db), registry);
}

before(async () => {
  if (!hasServerKey) return;
  db = liveSupabase()!;
  projectA = await createLiveProject(db, `${TAG}-proj-a`);
  projectB = await createLiveProject(db, `${TAG}-proj-b`);
  await createLiveMembership(db, projectA, ACTOR_A, 'member');
  created = [projectA, projectB];
});

after(async () => {
  if (hasServerKey) await cleanLive(db, created);
});

test('live: active project + member + known capability => run completes', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime();
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { message: 'hello' } });
  assert.ok(!('error' in res));
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.output, { message: 'hello' });
  assert.equal(await countLiveRuns(db, projectA), 1);
});

test('live: unknown project => not_found, no run created', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime(db);
  const res = await rt.execute({ projectId: 'no-such-project', actor: ACTOR_A, capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'not_found');
});

test('live: archived project => denied, no run created', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime(db);
  await setLiveProjectStatus(db, projectA, 'archived');
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo' });
  await setLiveProjectStatus(db, projectA, 'active');
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'validation');
  assert.equal(await countLiveRuns(db, projectA), 0);
});

test('live: actor without membership => authorization error, no run created', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime(db);
  const res = await rt.execute({ projectId: projectA, actor: 'unknown-actor', capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'authorization');
  assert.equal(await countLiveRuns(db, projectA), 0);
});

test('live: unknown capability => controlled failure, no run created', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime(db);
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.does-not-exist' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'not_found');
  assert.equal(await countLiveRuns(db, projectA), 0);
});

test('live: handler throws => run failed with completed_at, latency_ms, error_category', { skip: !hasServerKey }, async () => {
  const rt = throwingRuntime();
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { message: 'x' } });
  assert.ok(!('error' in res));
  assert.equal(res.status, 'failed');
  const runs = await readRuns(projectA);
  const run = runs.find((r) => r.capability_key === 'platform.echo');
  assert.ok(run);
  assert.equal(run.status, 'failed');
  assert.ok(run.completed_at !== null && run.completed_at !== undefined);
  assert.ok(run.latency_ms !== null && run.latency_ms !== undefined);
  assert.equal(run.error_category, 'runtime');
});

test('live: successful handler => run completed with completed_at, latency_ms', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime(db);
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { message: 'ok' } });
  assert.ok(!('error' in res));
  assert.equal(res.status, 'completed');
  const runs = await readRuns(projectA);
  const run = runs.find((r) => r.status === 'completed');
  assert.ok(run);
  assert.ok(run.completed_at !== null && run.completed_at !== undefined);
  assert.ok(run.latency_ms !== null && run.latency_ms !== undefined);
});

test('live: cross-project isolation — Actor A cannot execute on Project B', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime(db);
  const before = await countLiveRuns(db, projectB);
  const res = await rt.execute({ projectId: projectB, actor: ACTOR_A, capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'authorization');
  assert.equal(await countLiveRuns(db, projectB), 0);
  assert.equal(before, 0);
});

test('live: run privacy — runs store no raw input/output/prompt/response', { skip: !hasServerKey }, async () => {
  const rt = liveRuntime(db);
  await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { sensitive: 'do-not-store' } });
  const runs = await readRuns(projectA);
  const rows = runs.map((r) => Object.keys(r).sort().join(','));
  for (const keys of rows) {
    assert.ok(!keys.includes('input'));
    assert.ok(!keys.includes('output'));
    assert.ok(!keys.includes('prompt'));
    assert.ok(!keys.includes('response'));
    assert.ok(!JSON.stringify(runs).includes('do-not-store'));
  }
});

async function readRuns(projectId: string): Promise<Array<Record<string, unknown>>> {
  const q = db.from('runs').select('*').eq('project_id', projectId);
  const { data } = await (q as unknown as { data: Array<Record<string, unknown>> | null });
  return Array.isArray(data) ? data : [];
}