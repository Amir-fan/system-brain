import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpApi } from '../src/platform/api/http-server.ts';
import { RuntimeService } from '../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../src/core/capability/capability-registry.ts';
import { StaticTokenAuthenticator } from '../src/platform/api/static-authenticator.ts';
import { platformAiEcho } from '../src/core/capability/ai-echo.ts';
import type { ModelGateway, ModelGatewayOutput } from '../src/core/model-gateway/model-gateway.ts';
import type { RuntimePersistence, RunRecord } from '../src/core/runtime/runtime.ports.ts';

class FakeGateway implements ModelGateway {
  async generateText(): Promise<ModelGatewayOutput> {
    return { text: 'ai-answer', provider: 'fake', model: 'fake-mini', usage: { totalTokens: 9 }, latencyMs: 5 };
  }
}
class Mem implements RuntimePersistence {
  runs: RunRecord[] = [];
  async getProject(id: string) {
    return id === 'p1' ? { id, name: 'p1', status: 'active' as const, createdAt: 'x', updatedAt: 'x' } : null;
  }
  async getMembership(p: string, a: string) {
    return p === 'p1' && a === 'a1' ? { projectId: 'p1', actor: 'a1', role: 'member' as const, createdAt: 'x' } : null;
  }
  async createRun(r: RunRecord) {
    this.runs.push(r);
  }
  async updateRun(id: string, p: Partial<RunRecord>) {
    const r = this.runs.find((x) => x.id === id);
    if (r) Object.assign(r, p);
  }
}

const tokens = new Map([['tok-a', 'a1']]);
const auth0 = new StaticTokenAuthenticator(tokens);

test('api -> runtime -> ai capability (fake gateway): 200 + model metadata persisted', async () => {
  const persistence = new Mem();
  const registry = new MapCapabilityRegistry();
  registry.register('platform.ai-echo', platformAiEcho(new FakeGateway()));
  const runtime = new RuntimeService(persistence, registry);
  const server: Server = createHttpApi({ runtime, authenticator: auth0 });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const resp = await fetch(`${base}/v1/projects/p1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-a' },
      body: JSON.stringify({ capability: 'platform.ai-echo', input: { message: 'hi' } }),
    });
    const json = (await resp.json()) as any;
    assert.equal(resp.status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(json.result, { text: 'ai-answer' });
    assert.equal(persistence.runs[0].status, 'completed');
    assert.equal(persistence.runs[0].providerKey, 'fake');
    assert.equal(persistence.runs[0].modelName, 'fake-mini');
    assert.equal(persistence.runs[0].usage?.totalTokens, 9);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
});