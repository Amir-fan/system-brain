import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpApi } from '../src/platform/api/http-server.ts';
import { createKipApi } from '../src/platform/api/index.ts';
import { StaticTokenAuthenticator } from '../src/platform/api/static-authenticator.ts';
import { RuntimeService } from '../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../src/core/capability/capability-registry.ts';
import { MemoryService } from '../src/core/memory/memory.service.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { SkillsRuntime, type SkillExecutionInput } from '../src/core/skill/skill-runtime.ts';
import type { RuntimePersistence, RunRecord } from '../src/core/runtime/runtime.ports.ts';
import type { TokenActorMap } from '../src/platform/api/auth.ts';
import type { Actor, ProjectMembership, Role } from '../src/core/authorization/actor.ts';
import type { Project } from '../src/core/project/project.ts';

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
  async createRun(r: RunRecord) {
    this.runs.push(r);
  }
  async updateRun(id: string, p: Partial<RunRecord>) {
    const r = this.runs.find((x) => x.id === id);
    if (r) Object.assign(r, p);
  }
  clearRuns() {
    this.runs = [];
  }
}

const project = (id: string, status: Project['status']): Project => ({
  id,
  name: id,
  status,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const member = (projectId: string, actor: Actor, role: Role): ProjectMembership => ({
  projectId,
  actor,
  role,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const hasKey = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

let persistence: MemoryPersistence;
let registry: MapCapabilityRegistry;
let server: Server;
let base: string;
let post: (projectId: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: unknown }>;

const ACTOR_A = 'api-actor-a';
const ACTOR_B = 'api-actor-b';
const TOKEN_A = 'tok-a-secret';
const TOKEN_B = 'tok-b-secret';
const tokens: TokenActorMap = new Map([
  [TOKEN_A, ACTOR_A],
  [TOKEN_B, ACTOR_B],
]);
const P = 'proj-a';
const P_B = 'proj-b';

before(async () => {
  persistence = new MemoryPersistence();
  persistence.projects.set(P, project(P, 'active'));
  persistence.projects.set(P_B, project(P_B, 'active'));
  persistence.memberships.push(member(P, ACTOR_A, 'member'));

  registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => input);
  registry.register('platform.boom', async () => {
    throw new Error('boom');
  });

  server = createKipApi({ persistence, capabilities: registry, tokens });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  post = async (projectId, body, headers = {}) => {
    const res = await fetch(`${base}/v1/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
});

beforeEach(async () => {
  persistence.clearRuns();
  // guarantee clean membership/status baseline each test
  persistence.projects.get(P)!.status = 'active';
  persistence.projects.get(P_B)!.status = 'active';
  persistence.memberships = persistence.memberships.filter((m) => !(m.projectId === P && m.actor === ACTOR_A));
  persistence.memberships.push(member(P, ACTOR_A, 'member'));
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

test('api: valid authenticated actor + membership + echo => 200, run completed', async () => {
  const res = await post(P, { capability: 'platform.echo', input: { message: 'hello' } }, { authorization: `Bearer ${TOKEN_A}` });
  assert.equal(res.status, 200);
  const j = res.json as any;
  assert.equal(j.ok, true);
  assert.ok(j.runId);
  assert.deepEqual(j.result, { message: 'hello' });
  assert.equal(persistence.runs.length, 1);
  assert.equal(persistence.runs[0].status, 'completed');
});

test('api: malformed body => 400, no run', async () => {
  const res = await post(P, { capability: 42 }, { authorization: `Bearer ${TOKEN_A}` });
  assert.equal(res.status, 400);
  assert.equal((res.json as any).error.category, 'validation');
  assert.equal(persistence.runs.length, 0);
});

test('api: unknown project => 404, no run', async () => {
  const res = await post('no-such', { capability: 'platform.echo', input: {} }, { authorization: `Bearer ${TOKEN_A}` });
  assert.equal(res.status, 404);
  assert.equal((res.json as any).error.category, 'not_found');
  assert.equal(persistence.runs.length, 0);
});

test('api: unauthorized actor (no membership) => 403, no run', async () => {
  const res = await post(P, { capability: 'platform.echo', input: {} }, { authorization: `Bearer ${TOKEN_B}` });
  assert.equal(res.status, 403);
  assert.equal((res.json as any).error.category, 'authorization');
  assert.equal(persistence.runs.length, 0);
});

test('api: unknown capability => controlled error, no run', async () => {
  const res = await post(P, { capability: 'platform.nope', input: {} }, { authorization: `Bearer ${TOKEN_A}` });
  assert.equal(res.status, 404);
  assert.equal((res.json as any).error.category, 'not_found');
  assert.equal(persistence.runs.length, 0);
});

test('api: archived project => controlled error, no run', async () => {
  persistence.projects.get(P)!.status = 'archived';
  const res = await post(P, { capability: 'platform.echo', input: {} }, { authorization: `Bearer ${TOKEN_A}` });
  assert.equal(res.status, 400);
  assert.equal((res.json as any).error.category, 'validation');
  assert.equal(persistence.runs.length, 0);
});

test('api: handler failure => 500, failed run persisted', async () => {
  const res = await post(P, { capability: 'platform.boom', input: {} }, { authorization: `Bearer ${TOKEN_A}` });
  assert.equal(res.status, 500);
  assert.equal((res.json as any).error.category, 'runtime');
  assert.equal(persistence.runs.length, 1);
  assert.equal(persistence.runs[0].status, 'failed');
});

test('api: actorSubject in body is ignored, cannot impersonate', async () => {
  const res = await post(P, { capability: 'platform.echo', input: {}, actorSubject: ACTOR_B }, { authorization: `Bearer ${TOKEN_B}` });
  // authenticated as ACTOR_B via token; ACTOR_B has no membership => 403
  assert.equal(res.status, 403);
  assert.equal(persistence.runs.length, 0);
});

test('api: cross-project attempt denied', async () => {
  const res = await post(P_B, { capability: 'platform.echo', input: {} }, { authorization: `Bearer ${TOKEN_A}` });
  assert.equal(res.status, 403);
  assert.equal((res.json as any).error.category, 'authorization');
  // nothing written to proj-b
  assert.equal(persistence.runs.filter((r) => r.projectId === P_B).length, 0);
});

test('api: memory and skill routes deny an authenticated actor outside the target project', async (t) => {
  const recallActive = t.mock.fn(async () => []);
  const unexpectedStorageCall = async () => { throw new Error('unexpected memory storage call'); };
  const memoryService = new MemoryService({
    remember: unexpectedStorageCall,
    recallActive,
    history: unexpectedStorageCall,
    supersede: unexpectedStorageCall,
    archive: unexpectedStorageCall,
    retrieveRelevant: unexpectedStorageCall,
  });
  const skillRegistry = new MapSkillRegistry();
  const skillsRuntime = new SkillsRuntime({ persistence, registry: skillRegistry });
  const execute = t.mock.method(skillsRuntime, 'execute', async ({ skillId }: SkillExecutionInput) => ({
    status: 'completed' as const, skillId, skillVersion: 1,
  }));
  const authorizationServer = createHttpApi({
    runtime: new RuntimeService(persistence, registry),
    authenticator: new StaticTokenAuthenticator(tokens),
    memory: { service: memoryService, boundary: persistence },
    skills: { runtime: skillsRuntime, registry: skillRegistry, boundary: persistence },
  });
  t.after(() => new Promise<void>((resolve) => authorizationServer.close(() => resolve())));
  await new Promise<void>((resolve) => authorizationServer.listen(0, '127.0.0.1', resolve));
  const { port } = authorizationServer.address() as AddressInfo;
  const projectBase = `http://127.0.0.1:${port}/v1/projects`;
  const headers = { 'authorization': `Bearer ${TOKEN_A}`, 'content-type': 'application/json' };
  const routes = [
    { path: `memory/recall?subjectId=${ACTOR_A}`, init: { headers }, callCount: () => recallActive.mock.callCount() },
    {
      path: 'skills/test.echo/execute',
      init: { method: 'POST', headers, body: JSON.stringify({ subjectId: ACTOR_A, payload: {} }) },
      callCount: () => execute.mock.callCount(),
    },
  ];
  for (const { path, init, callCount } of routes) {
    const allowed = await fetch(`${projectBase}/${P}/${path}`, init);
    assert.equal(allowed.status, 200, path);
    await allowed.json();
    assert.equal(callCount(), 1, path);

    const denied = await fetch(`${projectBase}/${P_B}/${path}`, init);
    assert.equal(denied.status, 403, path);
    assert.deepEqual(await denied.json(), {
      ok: false, status: 403, error: { category: 'authorization', message: 'actor is not a member' },
    });
    assert.equal(callCount(), 1, path);
  }
});

test('api: no raw input/output/secret in runs', async () => {
  await post(P, { capability: 'platform.echo', input: { secret: 'top-secret-value' } }, { authorization: `Bearer ${TOKEN_A}` });
  const stored = persistence.runs[0];
  assert.ok(stored);
  assert.ok(!('input' in stored));
  assert.ok(!('output' in stored));
  assert.ok(!JSON.stringify(stored).includes('top-secret-value'));
});
