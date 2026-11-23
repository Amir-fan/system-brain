import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { compose } from '../src/platform/bootstrap/composition.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';
import { createModelAssignmentStorage } from '../src/platform/provider/model-assignment.ts';

// Only run when admin token + supabase + openrouter test key are present (live-ish API),
// but these exercise the admin route/auth contract against a real composed server.

const hasAdmin = Boolean(
  process.env.KIP_PLATFORM_ADMIN_TOKEN
  && process.env.SUPABASE_URL
  && process.env.SUPABASE_SECRET_KEY,
);
const hasStorage = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);

test('model-assignment API: admin auth required + assignment CRUD', { skip: !hasAdmin }, async () => {
  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!,
    openRouterModel: 'openrouter/auto',
    tokenActors: new Map(),
  }) as unknown as Server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const A = 'Bearer ' + process.env.KIP_PLATFORM_ADMIN_TOKEN;

  async function req(path: string, method: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: A },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  try {
    // admin auth required — no token
    const noAuth = await fetch(`${base}/v1/admin/model-assignments`);
    assert.equal(noAuth.status, 401);

    // GET: assert only about the workload THIS test owns. A live project can
    // legitimately hold other assignments (e.g. the approved `embeddings` model),
    // so the whole-table emptiness is not this test's contract.
    const seedDb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!) as unknown as SupabaseDatabase;
    await seedDb.from('model_assignments').delete().eq('workload_key', 'source_analysis');
    const empty = await req('/v1/admin/model-assignments', 'GET');
    assert.equal(empty.status, 200);
    const mine = (empty.json.data ?? []).filter((a: { workloadKey?: string }) => a.workloadKey === 'source_analysis');
    assert.deepEqual(mine, []);

    // PUT assign (validates against catalog only if a catalog is reachable; use a real openrouter model id if available)
    const validModel = ['anthropic/claude-3-5-sonnet-20241022', 'openai/gpt-4o-mini', 'meta-llama/llama-3.1-8b-instruct:free'].find(() => true)!;
    const put = await req('/v1/admin/model-assignments/source_analysis', 'PUT', { modelId: validModel });
    // Even if the catalog can't be reached (provider not connected), we accept any of:
    //  200 (stored)  OR  400 (catalog validation) — but must NOT 500/expose secret
    assert.ok([200, 400].includes(put.status));
    assert.ok(!JSON.stringify(put.json).includes('sk-'));

    // invalid workload rejected
    const bad = await req('/v1/admin/model-assignments/not-a-workload', 'PUT', { modelId: 'x' });
    assert.equal(bad.status, 400);

    // secret-free (no token, no secrets) — full response must not contain secrets
    assert.ok(!JSON.stringify(put.json).includes(process.env.OPENROUTER_TEST_KEY ?? '__absent__'));
    assert.ok(!JSON.stringify(empty.json).includes(process.env.OPENROUTER_TEST_KEY ?? '__absent__'));
  } finally {
    // cleanup
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!) as unknown as SupabaseDatabase;
    await db.from('model_assignments').delete().eq('workload_key', 'source_analysis');
    await new Promise<void>((r) => (server as Server).close(() => r()));
  }
});

test('model-assignment storage writes/reads (unit-ish, direct DB-path when live creds present)', { skip: !hasStorage }, async () => {
  const db = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
  ) as unknown as SupabaseDatabase;
  const storage = createModelAssignmentStorage(db);
  await storage.upsert('chat_assistant', 'openai/gpt-4o-mini');
  const read = await storage.get('chat_assistant');
  assert.ok(read && read.modelId === 'openai/gpt-4o-mini');
  await storage.remove('chat_assistant');
  assert.equal(await storage.get('chat_assistant'), null);
});
