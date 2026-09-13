import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeService } from '../src/core/runtime/runtime.service.ts';
import type { RuntimePersistence, RunRecord } from '../src/core/runtime/runtime.ports.ts';
import { MapCapabilityRegistry } from '../src/core/capability/capability-registry.ts';
import type { Project, ProjectStatus } from '../src/core/project/project.ts';
import type { ProjectMembership, Role, Actor } from '../src/core/authorization/actor.ts';

class MemoryPersistence implements RuntimePersistence {
  projects: Map<string, Project> = new Map();
  memberships: ProjectMembership[] = [];
  runs: RunRecord[] = [];

  async getProject(projectId: string) {
    return this.projects.get(projectId) ?? null;
  }
  async getMembership(projectId: string, actor: Actor) {
    return this.memberships.find((m) => m.projectId === projectId && m.actor === actor) ?? null;
  }
  async createRun(record: RunRecord) {
    this.runs.push(record);
  }
  async updateRun(id: string, patch: Partial<RunRecord>) {
    const run = this.runs.find((r) => r.id === id);
    if (run) Object.assign(run, patch);
  }
}

const seedProject = (id: string, status: ProjectStatus, name: string): Project => ({
  id,
  name,
  status,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const membership = (projectId: string, actor: Actor, role: Role): ProjectMembership => ({
  projectId,
  actor,
  role,
  createdAt: '2026-01-01T00:00:00.000Z',
});

function runtime(fake: MemoryPersistence, echoHandler?: (input: unknown) => unknown) {
  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => (echoHandler ? echoHandler(input) : input));
  return new RuntimeService(fake, registry);
}

test('valid active project + member + known capability => run completes', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-a', seedProject('p-a', 'active', 'A'));
  fake.memberships.push(membership('p-a', 'actor-1', 'owner'));
  const rt = runtime(fake);

  const res = await rt.execute({ projectId: 'p-a', actor: 'actor-1', capability: 'platform.echo', input: { message: 'hello' } });

  assert.ok(!('error' in res), 'should not be an error result');
  if ('error' in res) throw new Error('unexpected error');
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.output, { message: 'hello' });
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].status, 'completed');
  assert.ok(fake.runs[0].latencyMs !== undefined);
  assert.ok(fake.runs[0].completedAt !== undefined);
});

test('unknown project => controlled not_found, no run created', async () => {
  const fake = new MemoryPersistence();
  const rt = runtime(fake);
  const res = await rt.execute({ projectId: 'nope', actor: 'actor-1', capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal((res as { error: { kind: string } }).error.kind, 'not_found');
  assert.equal(fake.runs.length, 0);
});

test('archived project => denied, no run created', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-arch', seedProject('p-arch', 'archived', 'Archived'));
  fake.memberships.push(membership('p-arch', 'actor-1', 'owner'));
  const res = await runtime(fake).execute({ projectId: 'p-arch', actor: 'actor-1', capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal((res as { error: { kind: string } }).error.kind, 'validation');
  assert.equal(fake.runs.length, 0);
});

test('actor without membership => authorization failure, no run', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-a', seedProject('p-a', 'active', 'A'));
  const res = await runtime(fake).execute({ projectId: 'p-a', actor: 'stranger', capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal((res as { error: { kind: string } }).error.kind, 'authorization');
  assert.equal(fake.runs.length, 0);
});

test('unknown capability => controlled failure, no run', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-a', seedProject('p-a', 'active', 'A'));
  fake.memberships.push(membership('p-a', 'actor-1', 'member'));
  const res = await runtime(fake).execute({ projectId: 'p-a', actor: 'actor-1', capability: 'nonexistent.cap' });
  assert.ok('error' in res);
  assert.equal((res as { error: { kind: string } }).error.kind, 'not_found');
  assert.equal(fake.runs.length, 0);
});

test('handler throws => run exists, status failed, error_category populated', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-a', seedProject('p-a', 'active', 'A'));
  fake.memberships.push(membership('p-a', 'actor-1', 'member'));
  const rt = runtime(fake, () => {
    throw new Error('boom');
  });
  const res = await rt.execute({ projectId: 'p-a', actor: 'actor-1', capability: 'platform.echo', input: { message: 'x' } });
  assert.ok(!('error' in res));
  assert.deepEqual((res as { status: string }).status, 'failed');
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0].status, 'failed');
  assert.equal(fake.runs[0].errorCategory, 'runtime');
  assert.ok(fake.runs[0].completedAt !== undefined);
});

test('successful handler => completed + latency recorded', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-a', seedProject('p-a', 'active', 'A'));
  fake.memberships.push(membership('p-a', 'actor-1', 'service'));
  const res = await runtime(fake).execute({ projectId: 'p-a', actor: 'actor-1', capability: 'platform.echo' });
  assert.ok(!('error' in res));
  assert.equal(fake.runs[0].status, 'completed');
  assert.ok(fake.runs[0].latencyMs !== undefined && fake.runs[0].latencyMs >= 0);
});

test('project B actor cannot execute against project A without membership', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-a', seedProject('p-a', 'active', 'A'));
  fake.projects.set('p-b', seedProject('p-b', 'active', 'B'));
  fake.memberships.push(membership('p-b', 'actor-b', 'owner'));
  const res = await runtime(fake).execute({ projectId: 'p-a', actor: 'actor-b', capability: 'platform.echo' });
  assert.ok('error' in res);
  assert.equal((res as { error: { kind: string } }).error.kind, 'authorization');
  assert.equal(fake.runs.length, 0);
});

test('no raw input/output stored in runs', async () => {
  const fake = new MemoryPersistence();
  fake.projects.set('p-a', seedProject('p-a', 'active', 'A'));
  fake.memberships.push(membership('p-a', 'actor-1', 'member'));
  await runtime(fake).execute({
    projectId: 'p-a',
    actor: 'actor-1',
    capability: 'platform.echo',
    input: { message: 'sensitive-user-content' },
  });
  const stored = fake.runs[0];
  assert.ok(!('input' in stored));
  assert.ok(!('output' in stored));
  assert.ok(!JSON.stringify(stored).includes('sensitive-user-content'));
});