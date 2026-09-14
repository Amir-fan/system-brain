import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeService } from '../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../src/core/capability/capability-registry.ts';
import { platformAiEcho } from '../src/core/capability/ai-echo.ts';
import type { ModelGateway, ModelGatewayInput, ModelGatewayOutput } from '../src/core/model-gateway/model-gateway.ts';
import type { RuntimePersistence, RunRecord } from '../src/core/runtime/runtime.ports.ts';
import type { Actor, ProjectMembership, Role } from '../src/core/authorization/actor.ts';
import type { Project } from '../src/core/project/project.ts';

class FakeGateway implements ModelGateway {
  async embedTexts(): Promise<{ vectors: number[][]; provider?: string; model?: string }> {
    return { vectors: [[0.1, 0.2]], provider: 'fake', model: 'fake-embed' };
  }

  callCount = 0;
  lastInput?: ModelGatewayInput;
  failWith?: Error;
  generateText(input: ModelGatewayInput): Promise<ModelGatewayOutput> {
    this.callCount++;
    this.lastInput = input;
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({
      text: `echo:${String((input.input as { message?: unknown })?.message ?? '')}`,
      provider: 'fake',
      model: 'fake-mini',
      usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      latencyMs: 12,
    });
  }
}

class MemPersistence implements RuntimePersistence {
  projects = new Map<string, Project>();
  memberships: ProjectMembership[] = [];
  runs: RunRecord[] = [];
  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }
  async getMembership(p: string, a: Actor) {
    return this.memberships.find((m) => m.projectId === p && m.actor === a) ?? null;
  }
  async createRun(r: RunRecord) {
    this.runs.push(r);
  }
  async updateRun(id: string, p: Partial<RunRecord>) {
    const r = this.runs.find((x) => x.id === id);
    if (r) Object.assign(r, p);
  }
}

const mkProject = (id: string, name = id): Project => ({ id, name, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
const mkMember = (p: string, a: string, role: Role = 'member'): ProjectMembership => ({ projectId: p, actor: a, role, createdAt: '2026-01-01T00:00:00.000Z' });

function setup(gateway: ModelGateway) {
  const persistence = new MemPersistence();
  persistence.projects.set('p1', mkProject('p1'));
  persistence.memberships.push(mkMember('p1', 'a1'));
  const registry = new MapCapabilityRegistry();
  registry.register('platform.ai-echo', platformAiEcho(gateway));
  const runtime = new RuntimeService(persistence, registry);
  return { persistence, runtime };
}

test('model gateway contract: fake provider returns normalized output', async () => {
  const gateway = new FakeGateway();
  const out = await gateway.generateText({ projectId: 'p', runId: 'r', capability: 'platform.ai-echo', input: { message: 'hi' } });
  assert.equal(out.text, 'echo:hi');
  assert.equal(out.provider, 'fake');
  assert.equal(out.model, 'fake-mini');
  assert.ok(out.latencyMs !== undefined);
  assert.equal(out.usage?.totalTokens, 8);
});

test('AI capability through Runtime + fake gateway: provider failure => failed run', async () => {
  const gateway = new FakeGateway();
  gateway.failWith = new Error('provider down');
  const { runtime, persistence } = setup(gateway);
  const res = await runtime.execute({ projectId: 'p1', actor: 'a1', capability: 'platform.ai-echo', input: { message: 'hi' } });
  assert.equal((res as { status: string }).status, 'failed');
  assert.equal(persistence.runs[0].status, 'failed');
  assert.equal(persistence.runs[0].errorCategory, 'runtime');
});

test('AI capability through Runtime + fake gateway: run completes with model metadata', async () => {
  const gateway = new FakeGateway();
  const { runtime, persistence } = setup(gateway);
  const res = await runtime.execute({ projectId: 'p1', actor: 'a1', capability: 'platform.ai-echo', input: { message: 'hi' } });
  assert.equal((res as { status: string }).status, 'completed');
  assert.deepEqual((res as { output: unknown }).output, { text: 'echo:hi' });
  const run = persistence.runs[0];
  assert.equal(run.providerKey, 'fake');
  assert.equal(run.modelName, 'fake-mini');
  assert.equal(run.usage?.totalTokens, 8);
  assert.equal(gateway.lastInput?.model?.profile, 'source_analysis');
});