import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { createKipApi } from '../../src/platform/api/index.ts';
import { createSupabaseRuntimePersistence } from '../../src/platform/supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../../src/platform/supabase/supabase.persistence.ts';
import { MapCapabilityRegistry } from '../../src/core/capability/capability-registry.ts';
import type { TokenActorMap } from '../../src/platform/api/auth.ts';

const hasKey = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

const ACTOR_A = 'api-live-actor-a';
const ACTOR_B = 'api-live-actor-b';
const TOKEN_A = 'api-live-tok-a';
const TOKEN_B = 'api-live-tok-b';
const tokens: TokenActorMap = new Map([
  [TOKEN_A, ACTOR_A],
  [TOKEN_B, ACTOR_B],
]);

let db: SupabaseDatabase;
let server: Server;
let base: string;
let cleanRunIds: string[] = [];
let projectA = '';
let projectB = '';
const TAG = `api-live-${Date.now()}`;

async function post(projectId: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/projects/${projectId}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN_A}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function clearRuns(projectId: string): Promise<void> {
  await db.from('runs').delete().eq('project_id', projectId);
}
async function countRuns(projectId: string): Promise<number> {
  const q = db.from('runs').select('id').eq('project_id', projectId);
  const { data } = await (q as unknown as Promise<{ data: unknown[] | null }>);
  return Array.isArray(data) ? data.length : 0;
}

before(async () => {
  if (!hasKey) return;
  db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!) as unknown as SupabaseDatabase;

  const reg = new MapCapabilityRegistry();
  reg.register('platform.echo', async ({ input }) => input);
  reg.register('platform.boom', async () => {
    throw new Error('boom');
  });
  if (process.env.OPENAI_API_KEY) {
    const { OpenAiGateway } = await import('../../src/platform/model-gateway/openai.gateway.ts');
    const { platformAiEcho } = await import('../../src/core/capability/ai-echo.ts');
    const gw = new OpenAiGateway({ apiKey: process.env.OPENAI_API_KEY, model: process.env.MODEL_NAME ?? 'gpt-4o-mini' });
    reg.register('platform.ai-echo', platformAiEcho(gw));
  }
  server = createKipApi({ persistence: createSupabaseRuntimePersistence(db), capabilities: reg, tokens });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  projectA = await createLiveProject(`${TAG}-a`);
  projectB = await createLiveProject(`${TAG}-b`);
  await db.from('project_memberships').insert({ project_id: projectA, actor_subject: ACTOR_A, role: 'member' });
});

after(async () => {
  if (!hasKey) return;
  for (const pid of [projectA, projectB]) {
    await db.from('runs').delete().eq('project_id', pid);
    await db.from('project_memberships').delete().eq('project_id', pid);
    await db.from('projects').delete().eq('id', pid);
  }
  await new Promise<void>((res) => server.close(() => res()));
});

async function createLiveProject(name: string): Promise<string> {
  const { data } = await (db.from('projects').insert({ name, status: 'active' }).select('id') as unknown as Promise<{
    data: Array<{ id: string }> | null;
  }>);
  return data![0].id;
}

test('live api: valid auth + membership + echo => 200, run completed', { skip: !hasKey }, async () => {
  const r = await post(projectA, { capability: 'platform.echo', input: { message: 'hi' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.result, { message: 'hi' });
  assert.ok((await countRuns(projectA)) >= 1);
});

test('live api: malformed body => 400, no run', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  const r = await post(projectA, { capability: 42 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.category, 'validation');
  assert.equal(await countRuns(projectA), 0);
});

test('live api: unknown project => 404, no run', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  const r = await post('no-such-project', { capability: 'platform.echo', input: {} });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.category, 'not_found');
  assert.equal(await countRuns(projectA), 0);
});

test('live api: unauthorized actor => 403, no run', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  const r = await post(projectA, { capability: 'platform.echo', input: {} }, { authorization: `Bearer ${TOKEN_B}` });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.category, 'authorization');
  assert.equal(await countRuns(projectA), 0);
});

test('live api: unknown capability => controlled error, no run', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  const r = await post(projectA, { capability: 'platform.nope', input: {} });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.category, 'not_found');
  assert.equal(await countRuns(projectA), 0);
});

test('live api: archived project => controlled error, no run', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  await db.from('projects').update({ status: 'archived' }).eq('id', projectA);
  const r = await post(projectA, { capability: 'platform.echo', input: {} });
  await db.from('projects').update({ status: 'active' }).eq('id', projectA);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.category, 'validation');
  assert.equal(await countRuns(projectA), 0);
});

test('live api: handler failure => 500, failed run persisted', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  const r = await post(projectA, { capability: 'platform.boom', input: {} });
  assert.equal(r.status, 500);
  assert.equal(r.json.error.category, 'runtime');
  const q = db.from('runs').select('status, error_category').eq('project_id', projectA);
  const { data } = await (q as unknown as Promise<{ data: Array<{ status: string; error_category: string }> | null }>);
  assert.ok(data && data.length === 1);
  assert.equal(data[0].status, 'failed');
  assert.equal(data[0].error_category, 'runtime');
});

test('live api: actorSubject in body is ignored', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  const r = await post(projectA, { capability: 'platform.echo', input: {}, actorSubject: ACTOR_B }, { authorization: `Bearer ${TOKEN_A}` });
  // body claims ACTOR_B, but auth token is ACTOR_A who IS a member => 200 (identity from token, not body)
  assert.equal(r.status, 200);
});

test('live api: cross-project denied', { skip: !hasKey }, async () => {
  await clearRuns(projectB);
  const r = await post(projectB, { capability: 'platform.echo', input: {} });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.category, 'authorization');
  assert.equal(await countRuns(projectB), 0);
});

test('live api: ai-echo persists provider/model/usage metadata on completed run', { skip: !hasKey || !process.env.OPENAI_API_KEY }, async () => {
  await clearRuns(projectA);
  const r = await post(projectA, { capability: 'platform.ai-echo', input: { message: 'Reply with one word: ok' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const q = db.from('runs').select('provider_key, model_name, usage_tokens_total, status, error_category').eq('project_id', projectA);
  const { data } = await (q as unknown as Promise<{ data: Array<Record<string, unknown>> | null }>);
  assert.ok(data && data.length === 1);
  const run = data[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.error_category, null);
  assert.ok(run.provider_key, 'expected provider_key set');
  assert.ok(run.model_name, 'expected model_name set');
  assert.ok(Number(run.usage_tokens_total) > 0, 'expected token usage recorded');
});

test('live api: no raw input/output/secret in runs', { skip: !hasKey }, async () => {
  await clearRuns(projectA);
  await post(projectA, { capability: 'platform.echo', input: { secret: 'DO-NOT-STORE' } });
  const q = db.from('runs').select('*').eq('project_id', projectA);
  const { data } = await (q as unknown as Promise<{ data: Array<Record<string, unknown>> | null }>);
  assert.ok(data && data.length === 1);
  assert.ok(!('input' in data[0]));
  assert.ok(!('output' in data[0]));
  assert.ok(!JSON.stringify(data).includes('DO-NOT-STORE'));
});