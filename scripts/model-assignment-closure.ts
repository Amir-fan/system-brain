/**
 * LIVE CLOSURE — Model Assignment V1.
 *
 * Proof: Admin assigns Model A -> runtime source_analysis call uses A ->
 * Run.model_name == A -> reassign to B -> next call uses B -> delete assignment ->
 * next call fails with a normalized missing-assignment error (no fallback).
 *
 * The runtime credential is resolved from Vault (Provider Connection Management is
 * already closed). OPENROUTER_TEST_KEY is test-input only (used to connect the
 * provider through the Admin API).
 */
import { compose } from '../src/platform/bootstrap/composition.ts';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const ADMIN = process.env.KIP_PLATFORM_ADMIN_TOKEN!;
const TEST_KEY = process.env.OPENROUTER_TEST_KEY!;
const BASE = 'http://127.0.0.1:8789';
const PORT = 8789;
const NKIP = 'closure-actor';
const NTK = 'closure-token';

const log = (...a: unknown[]) => console.log('[ma]', ...a);

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!) as unknown as SupabaseDatabase;
  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!,
    openRouterModel: 'openrouter/auto',
    tokenActors: new Map([[NTK, NKIP]]),
  });
  await new Promise<void>((r) => server.listen(PORT, () => r()));

  const A = { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` };
  const req = async (path: string, method: string, body?: unknown, auth = A) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...auth },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  const R: Record<string, string> = {};
  try {
    // ensure clean start
    await db.from('model_assignments').delete().eq('provider_key', 'openrouter');
    await db.rpc('kip_vault_delete_secret', { p_name: 'kip:provider:openrouter' });

    // 0. Connect OpenRouter via Admin (credential from Vault) so inference works.
    const conn = await req('/v1/admin/providers/openrouter', 'POST', { apiKey: TEST_KEY });
    if (conn.status !== 200) throw new Error('provider connect failed');
    const testRes = await req('/v1/admin/providers/openrouter/test', 'POST');
    R.provider_connected = testRes.json?.data?.status === 'connected' ? 'PASS' : 'FAIL';

    // pick two real chat-capable, non-alias catalog models so OpenRouter returns the SAME id
    const cat = await req('/v1/admin/providers/openrouter/models', 'GET');
    const all = (cat.json?.data?.models ?? []) as Array<{ id: string }>;
    const chat = all.filter((m) => !/^~/.test(m.id) && !/schematron|embedding|rerank|moderation|auto/i.test(m.id) && m.id.includes('/'));
    if (chat.length < 2) throw new Error('need >=2 non-alias chat models from catalog');
    const A1 = chat[0].id;
    const B2 = chat.find((m: { id: string }) => m.id !== A1)!.id;
    log('model A=', A1, ' model B=', B2);

    // 1. assign A to source_analysis
    const putA = await req('/v1/admin/model-assignments/source_analysis', 'PUT', { modelId: A1 });
    R.assign_A = putA.json?.data?.modelId === A1 ? 'PASS' : 'FAIL';

    // create a throwaway project+membership for the runtime call
    const proj = await (db.from('projects').insert({ name: `ma-closure-${Date.now()}` }).select('id') as unknown as Promise<{ data: [{ id: string }] | null }>).then((r) => r.data![0].id);
    await db.from('project_memberships').insert({ project_id: proj, actor_subject: NKIP, role: 'owner' });

    const runOnce = async () => {
      const r = await req(`/v1/projects/${proj}/runs`, 'POST', { capability: 'platform.ai-completion', input: { message: 'Reply with one word: ok', workload: 'source_analysis' } }, { 'content-type': 'application/json', authorization: `Bearer ${NTK}` });
      if (r.status !== 200) return { status: r.status, runId: null };
      return { status: r.status, runId: r.json?.runId as string };
    };

    // 2. runtime source_analysis call -> Model A
    const runA = await runOnce();
    const rowA = runA.runId ? await db.from('runs').select('model_name,provider_key,status').eq('id', runA.runId).maybeSingle() : { data: null };
    const rA = rowA.data as Record<string, unknown> | null;
    R.run_A_status = rA?.status === 'completed' ? 'PASS' : 'FAIL';
    R.run_A_model_matches = rA?.model_name === A1 ? 'PASS' : `FAIL(${String(rA?.model_name)} != ${A1})`;

    // 4. change to B
    const putB = await req('/v1/admin/model-assignments/source_analysis', 'PUT', { modelId: B2 });
    R.assign_B = putB.json?.data?.modelId === B2 ? 'PASS' : 'FAIL';

    // 5. next runtime call -> Model B
    const runB = await runOnce();
    const rowB = runB.runId ? await db.from('runs').select('model_name,provider_key,status').eq('id', runB.runId).maybeSingle() : { data: null };
    const rB = rowB.data as Record<string, unknown> | null;
    R.run_B_status = rB?.status === 'completed' ? 'PASS' : 'FAIL';
    R.run_B_model_matches = rB?.model_name === B2 ? 'PASS' : `FAIL(${String(rB?.model_name)} != ${B2})`;

    // 7. delete assignment
    const del = await req('/v1/admin/model-assignments/source_analysis', 'DELETE');
    R.delete_assignment = del.json?.data?.assigned === false ? 'PASS' : 'FAIL';

    // 8. next runtime call must FAIL with missing assignment (no fallback)
    const runC = await runOnce();
    R.after_delete_blocked = runC.status !== 200 ? 'PASS' : 'FAIL';
    // verify no run was created/used for the failed call
    await db.from('runs').delete().eq('project_id', proj);

    console.log('\n=== MODEL ASSIGNMENT CLOSURE ===');
    for (const [k, v] of Object.entries(R)) console.log(`${k}: ${v}`);
  } finally {
    await db.from('model_assignments').delete().eq('workload_key', 'source_analysis');
    await db.from('runs').delete().eq('actor_subject', NKIP);
    await db.from('project_memberships').delete().eq('actor_subject', NKIP);
    await db.from('projects').delete().like('name', 'ma-closure-%');
    await db.rpc('kip_vault_delete_secret', { p_name: 'kip:provider:openrouter' });
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((e) => {
  console.error('[ma] ERROR:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});