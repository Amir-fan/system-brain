/**
 * LIVE CLOSURE — Project Context & Member Authentication V1 (checkpoints 1-3).
 * Real Supabase Auth token -> Actor -> ProjectBoundary -> membership -> GET /v1/projects
 * discovery + A/B isolation. The admin/service client is never signed-in (so it
 * keeps role-safe inserts); the user token is obtained via a separate client.
 */
import { createClient } from '@supabase/supabase-js';
import { compose } from '../src/platform/bootstrap/composition.ts';
import { SupabaseActorAuthenticator } from '../src/platform/api/supabase-authenticator.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = `pc-${Date.now()}@test.local`;
const PASSWORD = `TestPw-${Date.now()}`;

const log = (...a: unknown[]) => console.log('[auth]', ...a);

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const db = admin as unknown as SupabaseDatabase;

  // Create a real Supabase user with the service/admin client.
  const { data: { user }, error: ue } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
  if (ue || !user) throw new Error('user create failed: ' + ue?.message);

  // Sign in with a SEPARATE client so the admin/service client stays role-safe.
  const userClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: login, error: le } = await userClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (le || !login.session) throw new Error('signin failed: ' + le?.message);
  const token = login.session.access_token;
  log('user', user.id);

  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!,
    openRouterModel: 'openrouter/auto',
    tokenActors: new Map(),
  });
  await new Promise<void>((r) => server.listen(PORT, () => r()));

  const R: Record<string, string> = {};
  const req = (path: string, t?: string) =>
    fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${t ?? token}` } }).then(async (r) => ({ status: r.status, json: await r.json() }));

  let projA = '';
  let projB = '';

  try {
    // Checkpoint 1: authenticator resolves token -> Actor.subject (independent + via route)
    const authc = new SupabaseActorAuthenticator({ auth: admin.auth });
    const got = await authc.authenticate(token);
    R.cp1_authenticator_subject = got.actor === user.id ? 'PASS' : 'FAIL';
    const bad = await req('/v1/projects', 'garbage-token');
    R.cp1_invalid_token_401 = bad.status === 401 ? 'PASS' : 'FAIL';

    // Checkpoint 2: membership -> sources list OK for A; denied for B (no membership)
    projA = (await db.from('projects').insert({ name: `auth-a-${Date.now()}` }).select('id')).data![0].id as string;
    projB = (await db.from('projects').insert({ name: `auth-b-${Date.now()}` }).select('id')).data![0].id as string;
    await db.from('project_memberships').insert({ project_id: projA, actor_subject: user.id, role: 'owner' });

    const sA = await req(`/v1/projects/${projA}/sources`);
    R.cp2_membership_sources_ok = sA.status === 200 ? 'PASS' : 'FAIL';
    const sB = await req(`/v1/projects/${projB}/sources`);
    R.cp2_no_membership_sources_denied = sB.status === 403 ? 'PASS' : 'FAIL';

    // Checkpoint 3: discovery
    const my1 = await req('/v1/projects');
    R.cp3_sees_A = (my1.json.data ?? []).some((p: { id: string }) => p.id === projA) ? 'PASS' : 'FAIL';
    R.cp3_hides_B = !(my1.json.data ?? []).some((p: { id: string }) => p.id === projB) ? 'PASS' : 'FAIL';

    await db.from('project_memberships').insert({ project_id: projB, actor_subject: user.id, role: 'member' });
    const my2 = await req('/v1/projects');
    R.cp3_add_B_visible = (my2.json.data ?? []).some((p: { id: string }) => p.id === projB) ? 'PASS' : 'FAIL';

    await db.from('project_memberships').delete().eq('project_id', projB).eq('actor_subject', user.id);
    const my3 = await req('/v1/projects');
    R.cp3_remove_B_hidden = !(my3.json.data ?? []).some((p: { id: string }) => p.id === projB) ? 'PASS' : 'FAIL';

    console.log('\n=== AUTH CLOSURE ===');
    for (const [k, v] of Object.entries(R)) console.log(`${k}: ${v}`);
  } finally {
    try { await db.from('sources').delete().eq('project_id', projA); } catch { /* noop */ }
    try { await db.from('project_memberships').delete().eq('project_id', projA); } catch { /* noop */ }
    try { await db.from('project_memberships').delete().eq('project_id', projB); } catch { /* noop */ }
    try { await db.from('projects').delete().eq('id', projA); } catch { /* noop */ }
    try { await db.from('projects').delete().eq('id', projB); } catch { /* noop */ }
    try { await admin.auth.admin.deleteUser(user.id); } catch { /* noop */ }
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((e) => {
  console.error('[auth] ERROR:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});