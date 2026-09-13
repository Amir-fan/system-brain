/**
 * Closure child: boots a fresh composed KIP server (exact runtime path — no env
 * OpenRouter credential; credential resolved ONLY from Vault, same as `compose`),
 * provisions a throwaway project + membership, then executes platform.ai-echo
 * through the real API/runtime. Prints `[res] key=value`.
 */
import { compose } from '../src/platform/bootstrap/composition.ts';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const emit = (k: string, v: unknown) => console.log(`[res] ${k}=${v}`);
const PORT = Number(process.env.CLOSURE_PORT ?? 8790);
const TOKEN = process.env.KIP_API_TOKEN ?? 'closure-token';
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!) as unknown as SupabaseDatabase;

  // project + membership so the runtime's project resolution/authorization pass
  const proj = await (db.from('projects').insert({ name: `closure-project` }).select('id') as unknown as Promise<{
    data: [{ id: string }] | null;
  }>).then((r) => r.data?.[0]?.id);
  if (!proj) throw new Error('failed to create closure project');
  await db.from('project_memberships').insert({ project_id: proj, actor_subject: 'closure', role: 'owner' });

  // Boot the real runtime composition. This is the exact path the app uses:
  //   compose() reads the OpenRouter secret from provider_configs + Vault.
  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!,
    tokenActors: new Map([[TOKEN, 'closure']]),
  });
  await new Promise<void>((r) => server.listen(PORT, () => r()));

  let output: Record<string, string> = {};
  try {
    const res = await fetch(`${BASE}/v1/projects/${proj}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ capability: 'platform.ai-echo', input: { message: 'Reply with the single word: ok' } }),
    });
    const json = (await res.json()) as any;

    if (res.status !== 200) {
      // blocked path (no credential) or provider failure
      emit('runtime_inference', json?.ok === false ? 'blocked' : 'error');
      emit('http_status', res.status);
      emit('error_message', json?.error?.message ?? '');
    } else {
      const runId = json.runId;
      emit('runtime_inference', 'completed');
      emit('runId', runId);
      const row = await db.from('runs').select('provider_key,model_name,usage_tokens_total,latency_ms,status').eq('id', runId).maybeSingle();
      const r = row.data as Record<string, unknown> | null;
      emit('run_status', r?.status ?? '');
      emit('provider_key', r?.provider_key ?? '');
      emit('model_name', r?.model_name ?? '');
      emit('usage_total', r?.usage_tokens_total ?? 0);
      emit('latency_ms', r?.latency_ms ?? -1);
    }

    // cleanup this child's test project
    await db.from('runs').delete().eq('project_id', proj);
    await db.from('project_memberships').delete().eq('project_id', proj);
    await db.from('projects').delete().eq('id', proj);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((e) => {
  emit('harness_error', e instanceof Error ? e.message : String(e));
  process.exit(1);
});