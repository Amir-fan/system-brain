/**
 * Stage 3 trusted provisioning — regression tests.
 *
 * POST /v1/projects/{p}/memberships is the ONE path a verified Naqaa user becomes a KIP
 * project member: the trusted proxy credential (service actor, manage on the project)
 * provisions the VERIFIED uid as role 'member'. End users can never self-provision;
 * arbitrary clients can never reach the path; existing stronger memberships are never
 * downgraded; the operation is idempotent.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpApi } from '../src/platform/api/http-server.ts';
import { RuntimeService } from '../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../src/core/capability/capability-registry.ts';
import type { RuntimePersistence, RunRecord } from '../src/core/runtime/runtime.ports.ts';
import type { Actor, ProjectMembership, Role } from '../src/core/authorization/actor.ts';
import type { Project } from '../src/core/project/project.ts';

const SVC = 'naqaa-proxy';       // trusted service identity
const SVC_TOKEN = 'svc-token-secret';
const USER_TOKEN = 'user-token-secret';
const USER = 'naqaa-uid-real-1'; // a VERIFIED Naqaa uid (JWT-verified upstream)
const P = 'proj-naqaa';
const P_FOREIGN = 'proj-foreign';

class MemPersistence implements RuntimePersistence {
  projects = new Map<string, Project>();
  memberships: ProjectMembership[] = [];
  runs: RunRecord[] = [];
  async getProject(id: string) { return this.projects.get(id) ?? null; }
  async getMembership(p: string, a: Actor) { return this.memberships.find((m) => m.projectId === p && m.actor === a) ?? null; }
  async ensureMembership(p: string, a: Actor, role: Role) {
    const existing = await this.getMembership(p, a);
    if (existing) return existing; // never downgrade / never duplicate
    const m: ProjectMembership = { projectId: p, actor: a, role, createdAt: new Date().toISOString() };
    this.memberships.push(m);
    return m;
  }
  async createRun(r: RunRecord) { this.runs.push(r); }
  async updateRun(id: string, patch: Partial<RunRecord>) {
    const r = this.runs.find((x) => x.id === id); if (r) Object.assign(r, patch);
  }
}

/** Composite authenticator stub mirroring CompositeActorAuthenticator semantics. */
const compositeAuth = {
  async authenticate(token: string) {
    if (token === SVC_TOKEN) return { actor: SVC };
    if (token === USER_TOKEN) return { actor: USER };
    throw new Error('unauthenticated');
  },
  async authenticateComposite(token: string) {
    if (token === SVC_TOKEN) return { actor: SVC, isProxy: true };
    if (token === USER_TOKEN) return { actor: USER, isProxy: false };
    throw new Error('unauthenticated');
  },
};

let server: Server;
let base: string;
let persistence: MemPersistence;

const provision = (projectId: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${base}/v1/projects/${projectId}/memberships`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));

before(async () => {
  persistence = new MemPersistence();
  const proj = (id: string): Project => ({ id, name: id, status: 'active', createdAt: '', updatedAt: '' });
  persistence.projects.set(P, proj(P));
  persistence.projects.set(P_FOREIGN, proj(P_FOREIGN));
  // The trusted service identity manages ONLY the Naqaa project.
  persistence.memberships.push({ projectId: P, actor: SVC, role: 'service', createdAt: '' });
  // A pre-existing owner we must never downgrade.
  persistence.memberships.push({ projectId: P, actor: 'existing-owner', role: 'owner', createdAt: '' });

  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => input);
  const runtime = new RuntimeService(persistence, registry);
  server = createHttpApi({
    runtime,
    authenticator: compositeAuth as never,
    conversation: { service: {} as never, boundary: persistence, membershipWriter: persistence },
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => { await new Promise<void>((res) => server.close(() => res())); });

test('A: verified user with no membership is provisioned as member', async () => {
  const res = await provision(P, { subject_id: USER }, { authorization: `Bearer ${SVC_TOKEN}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.role, 'member');
  assert.equal(res.json.data.subject, USER);
  const m = await persistence.getMembership(P, USER);
  assert.equal(m?.role, 'member');
});

test('B: second provisioning is idempotent (no duplicate, no change)', async () => {
  const before1 = persistence.memberships.filter((m) => m.projectId === P && m.actor === USER).length;
  const res = await provision(P, { subject_id: USER }, { authorization: `Bearer ${SVC_TOKEN}` });
  assert.equal(res.status, 200);
  const after1 = persistence.memberships.filter((m) => m.projectId === P && m.actor === USER).length;
  assert.equal(before1, 1);
  assert.equal(after1, 1);
});

test('C: an untrusted/end-user caller can NEVER provision (not even itself)', async () => {
  const res = await provision(P, { subject_id: USER }, { authorization: `Bearer ${USER_TOKEN}` });
  assert.equal(res.status, 403);
  const noAuth = await provision(P, { subject_id: 'x' }, {});
  assert.equal(noAuth.status, 401);
  // and the proxy identity cannot be spoofed via x-kip-actor on this route
  const spoof = await provision(P, { subject_id: 'attacker' }, { authorization: `Bearer ${USER_TOKEN}`, 'x-kip-actor': SVC });
  assert.equal(spoof.status, 403);
});

test('D: trusted proxy cannot provision into a project it cannot manage', async () => {
  const res = await provision(P_FOREIGN, { subject_id: USER }, { authorization: `Bearer ${SVC_TOKEN}` });
  assert.equal(res.status, 403);
  assert.equal(await persistence.getMembership(P_FOREIGN, USER), null);
});

test('E: an existing owner membership is never downgraded', async () => {
  const res = await provision(P, { subject_id: 'existing-owner' }, { authorization: `Bearer ${SVC_TOKEN}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.role, 'owner'); // unchanged
  assert.equal((await persistence.getMembership(P, 'existing-owner'))?.role, 'owner');
});

test('F: the provisioned role is always member — the caller cannot elevate', async () => {
  const res = await provision(P, { subject_id: 'elevate-attempt', role: 'owner' }, { authorization: `Bearer ${SVC_TOKEN}` });
  assert.equal(res.status, 200);
  assert.equal((await persistence.getMembership(P, 'elevate-attempt'))?.role, 'member');
});

test('G: missing subject_id is a validation error; nothing is written', async () => {
  const res = await provision(P, {}, { authorization: `Bearer ${SVC_TOKEN}` });
  assert.equal(res.status, 400);
});
