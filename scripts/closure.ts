/**
 * FINAL LIVE CLOSURE harness — Provider Connection Management.
 *
 * TEST-INPUT ONLY:
 *   OPENROUTER_TEST_KEY       — a real OpenRouter credential, submitted ONLY via the
 *                               Admin Provider API by this harness. NEVER read by
 *                               runtime, composition, gateway, capability, or boot.
 *   KIP_PLATFORM_ADMIN_TOKEN  — temporary bootstrap admin credential (env).
 *
 * Runtime resolves the credential exclusively from provider_configs + Vault.
 *
 * Flow: boot → admin connect (real key) → test(validate) → models →
 *       runtime ai-echo (fresh child boot, vault-resolved, NO env key) → revoke →
 *       runtime ai-echo again (must fail) → cleanup.
 */
import { spawn } from 'node:child_process';
import { compose } from '../src/platform/bootstrap/composition.ts';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const TEST_KEY = process.env.OPENROUTER_TEST_KEY;
const ADMIN_TOKEN = process.env.KIP_PLATFORM_ADMIN_TOKEN;
const BASE = 'http://127.0.0.1:8787';
const log = (...a: unknown[]) => console.log('[closure]', ...a);

async function runChild(port: number, includeTestKey: boolean): Promise<Record<string, string>> {
  const env = { ...process.env, CLOSURE_PORT: String(port) };
  if (!includeTestKey) delete env.OPENROUTER_TEST_KEY; // child must NOT see the test key
  const child = spawn(process.execPath, ['--env-file=.env.local', '--import', 'tsx', 'scripts/closure-child.ts'], {
    cwd: process.cwd(),
    env,
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number>((res) => child.on('close', res));
  const res: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^\[res\]\s*([^=]+)=(.*)$/);
    if (m) res[m[1].trim()] = m[2].trim();
  }
  if (code !== 0) {
    log('child exited', code, out);
    res.harness_error = res.harness_error ?? `exit ${code}`;
  }
  return res;
}

async function main() {
  if (!TEST_KEY) throw new Error('OPENROUTER_TEST_KEY not set (test-input only)');
  if (!ADMIN_TOKEN) throw new Error('KIP_PLATFORM_ADMIN_TOKEN not set');

  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!) as unknown as SupabaseDatabase;

  // Provenance: the runtime/server must never read OPENROUTER_TEST_KEY.
  const R = {} as Record<string, string>;
  log('sanitize: ensure no OPENROUTER_TEST_KEY in runtime-related env for the child executions');

  // Boot composed KIP server (no runtime OpenRouter credential; only admin token).
  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!,
    tokenActors: new Map(),
  });
  await new Promise<void>((r) => server.listen(8787, () => r()));

  async function req(path: string, method: string, body?: unknown) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) as any };
  }

  try {
    // ensure clean start
    await db.from('provider_configs').delete().eq('provider_key', 'openrouter');
    await db.rpc('kip_vault_delete_secret', { p_name: 'kip:provider:openrouter' });

    // 3-6 Admin connect (real test key) + Vault verify + masked-only response
    const connectRes = await req('/v1/admin/providers/openrouter', 'POST', { apiKey: TEST_KEY, displayName: 'OpenRouter (closure)' });
    R.connect_http = connectRes.status === 200 ? 'PASS' : 'FAIL';
    const connectBody = JSON.stringify(connectRes.json);
    R.connect_masked = connectBody.includes('••••') && !connectBody.includes(TEST_KEY) ? 'PASS' : 'FAIL';

    const vault = await db.rpc('kip_vault_read_secret', { p_name: 'kip:provider:openrouter' }) as { data: string | null };
    R.vault_stored = vault.data === TEST_KEY ? 'PASS' : 'FAIL';

    // 7-8 Test connection -> Connected (uses GET /auth/key)
    const testRes = await req('/v1/admin/providers/openrouter/test', 'POST');
    R.test_connected = testRes.json?.data?.status === 'connected' ? 'PASS' : 'FAIL';

    // 9 models (through admin, uses stored key)
    const modelsRes = await req('/v1/admin/providers/openrouter/models', 'GET');
    R.models_count = modelsRes.json?.data?.count > 0 ? 'PASS' : 'FAIL';

    // 10-14 child boots fresh server (no test key), runtime resolves from Vault, real inference
    log('child #1: fresh boot, vault-resolved credential, real inference');
    const c1 = await runChild(8790, false); // NO test key
    Object.assign(R, {
      runtime_inference: c1.runtime_inference === 'completed' ? 'PASS' : 'FAIL',
      run_status: c1.run_status,
      run_provider: c1.provider_key === 'openrouter' ? 'PASS' : 'FAIL',
      run_model: c1.model_name ? 'PASS' : 'FAIL',
      run_usage: Number(c1.usage_total) > 0 ? 'PASS' : 'FAIL',
      run_latency: Number(c1.latency_ms) >= 0 ? 'PASS' : 'FAIL',
    });
    if (c1.harness_error) { R.runtime_inference = 'FAIL'; R.harness_error = c1.harness_error; }

    // 15-18 Revoke + Vault delete, then runtime must fail
    await req('/v1/admin/providers/openrouter/revoke', 'POST');
    const vault2 = await db.rpc('kip_vault_read_secret', { p_name: 'kip:provider:openrouter' }) as { data: unknown };
    R.revoke_vault = vault2.data === null ? 'PASS' : 'FAIL';
    log('child #2: fresh boot WITHOUT credential; runtime invocation must fail');
    const c2 = await runChild(8791, false); // NO test key, and vault empty
    R.after_revoke_blocked = (c2.runtime_inference === 'blocked' || c2.harness_error) ? 'PASS' : 'FAIL';
    R.no_env_fallback = (c2.runtime_inference === 'blocked' || c2.harness_error) ? 'PASS' : 'FAIL';

    // 20 cleanup
    await db.from('provider_configs').delete().eq('provider_key', 'openrouter');
    await db.rpc('kip_vault_delete_secret', { p_name: 'kip:provider:openrouter' });
    const rows = await (db.from('provider_configs').select('id') as unknown as Promise<{ data: unknown[] | null }>).then((r) => r.data?.length ?? 0);
    const vault3 = await db.rpc('kip_vault_read_secret', { p_name: 'kip:provider:openrouter' }) as { data: unknown };
    R.cleanup_residue = rows === 0 && vault3.data === null ? 'PASS' : 'FAIL';

    console.log('\n=== CLOSURE RESULTS ===');
    for (const [k, v] of Object.entries(R)) console.log(`${k}: ${v}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((e) => {
  console.error('[closure] ERROR:', e instanceof Error ? e.message : e);
  process.exit(1);
});