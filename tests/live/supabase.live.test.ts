import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  liveSupabase,
  createLiveProject,
  createLiveMembership,
  setLiveProjectStatus,
  cleanLive,
  countLiveRuns,
  clearLiveRuns,
  clearLiveMemberships,
} from './supabase.helpers.ts';
import { createSupabaseRuntimePersistence } from '../../src/platform/supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../../src/platform/supabase/supabase.persistence.ts';
import { RuntimeService } from '../../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../../src/core/capability/capability-registry.ts';

import type { CapabilityHandler } from '../../src/core/capability/capability.ts';

const hasServerKey = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

let db: SupabaseDatabase;
let projectA = '';
let projectB = '';
let created: string[] = [];
const ACTOR_A = 'k0sb-actor-a';
const TAG = `k0sb-${Date.now()}`;

function runtimeWith(handler?: CapabilityHandler): RuntimeService {
  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', handler ?? (async ({ input }) => input));
  return new RuntimeService(createSupabaseRuntimePersistence(db), registry);
}

async function refreshMembershipA(): Promise<void> {
  await clearLiveMemberships(db, projectA);
  await createLiveMembership(db, projectA, ACTOR_A, 'member');
}

before(async () => {
  if (!hasServerKey) return;
  db = liveSupabase()!;
  projectA = await createLiveProject(db, `${TAG}-proj-a`);
  projectB = await createLiveProject(db, `${TAG}-proj-b`);
  await createLiveMembership(db, projectA, ACTOR_A, 'member');
  created = [projectA, projectB];
});

beforeEach(async () => {
  if (!hasServerKey) return;
  await clearLiveRuns(db, projectA);
  await clearLiveRuns(db, projectB);
  await setLiveProjectStatus(db, projectA, 'active');
  await refreshMembershipA();
});

after(async () => {
  if (hasServerKey) await cleanLive(db, created);
});

test('live: active project + member + known capability => run completes', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { message: 'hello' } });
  assert.ok(!('error' in res));
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.output, { message: 'hello' });
  const runs = await readRuns(projectA);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
});

test('live: unknown project => not_found, no run created', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  const res = await rt.execute({ projectId: 'no-such-project-xyz', actor: ACTOR_A, capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'not_found');
});

test('live: archived project => denied, no run created', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  await setLiveProjectStatus(db, projectA, 'archived');
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'validation');
  assert.equal(await countLiveRuns(db, projectA), 0);
});

test('live: actor without membership => authorization error, no run created', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  const res = await rt.execute({ projectId: projectA, actor: 'unknown-actor-xyz', capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'authorization');
  assert.equal(await countLiveRuns(db, projectA), 0);
});

test('live: unknown capability => controlled failure, no run created', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.does-not-exist' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'not_found');
  assert.equal(await countLiveRuns(db, projectA), 0);
});

test('live: handler throws => run failed with completed_at, latency_ms, error_category', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith(
    async () => {
      throw new Error('boom');
    },
  );
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { message: 'x' } });
  assert.ok(!('error' in res));
  assert.equal(res.status, 'failed');
  const runs = await readRuns(projectA);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.status, 'failed');
  assert.ok(run.completed_at !== null && run.completed_at !== undefined);
  assert.ok(run.latency_ms !== null && run.latency_ms !== undefined);
  assert.equal(run.error_category, 'runtime');
});

test('live: successful handler => run completed with completed_at, latency_ms', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  const res = await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { message: 'ok' } });
  assert.ok(!('error' in res));
  assert.equal(res.status, 'completed');
  const runs = await readRuns(projectA);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.status, 'completed');
  assert.ok(run.completed_at !== null && run.completed_at !== undefined);
  assert.ok(run.latency_ms !== null && run.latency_ms !== undefined);
});

test('live: cross-project isolation — Actor A cannot execute on Project B', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  const before = await countLiveRuns(db, projectB);
  assert.equal(before, 0);
  const res = await rt.execute({ projectId: projectB, actor: ACTOR_A, capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal(res.error.kind, 'authorization');
  assert.equal(await countLiveRuns(db, projectB), 0);
});

test('live: run privacy — runs table has no content-storage columns', { skip: !hasServerKey }, async () => {
  const rt = runtimeWith();
  await rt.execute({ projectId: projectA, actor: ACTOR_A, capability: 'platform.echo', input: { sensitive: 'do-not-store' } });
  const runs = await readRuns(projectA);
  assert.ok(runs.length >= 1);
  const keys = Object.keys(runs[0]);
  // trace metadata only; usage-token columns are legitimate aggregate counters.
  for (const forbidden of ['input', 'output', 'prompt', 'response', 'conversation', 'content', 'request']) {
    assert.ok(!keys.includes(forbidden), `unexpected content column: ${forbidden}`);
  }
  assert.ok(!JSON.stringify(runs).includes('do-not-store'));
});

async function readRuns(projectId: string): Promise<Array<Record<string, unknown>>> {
  const q = db.from('runs').select('*').eq('project_id', projectId);
  const { data } = await (q as unknown as Promise<{ data: Array<Record<string, unknown>> | null }>);
  return Array.isArray(data) ? data : [];
}