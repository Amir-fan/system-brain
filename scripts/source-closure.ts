/**
 * LIVE CLOSURE — Source Registry V1 (backend checkpoints 1-3).
 * Proves real Supabase persistence + real project-boundary authorization +
 * Project A/B cross-project isolation. No mocks.
 */
import { compose } from '../src/platform/bootstrap/composition.ts';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const A_TOKEN = 'srcA-token';
const B_TOKEN = 'srcB-token';
const OWNER = 'src-owner';
const GB_TOKEN = 'srcGB-token';
const GB = 'src-guest-b';

const log = (...a: unknown[]) => console.log('[src]', ...a);

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!) as unknown as SupabaseDatabase;
  const server = await compose({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY!,
    openRouterModel: 'openrouter/auto',
    tokenActors: new Map([
      [A_TOKEN, OWNER],
      [B_TOKEN, 'src-owner-b'],
      [GB_TOKEN, GB],
    ]),
  });
  await new Promise<void>((r) => server.listen(PORT, () => r()));

  const R: Record<string, string> = {};
  let projectA = '';
  let projectB = '';
  let sourceId = '';

  const req = async (path: string, method: string, token: string, body?: unknown) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  try {
    // clean start
    await db.from('sources').delete().eq('status', 'registered');

    // 1-2 create Projects A and B
    projectA = (await db.from('projects').insert({ name: `src-a-${Date.now()}` }).select('id')).data![0].id;
    projectB = (await db.from('projects').insert({ name: `src-b-${Date.now()}` }).select('id')).data![0].id;
    // memberships: owner of A with A_token; owner of B with B_token; guest GB is a member of B only
    await db.from('project_memberships').insert({ project_id: projectA, actor_subject: OWNER, role: 'owner' });
    await db.from('project_memberships').insert({ project_id: projectB, actor_subject: 'src-owner-b', role: 'owner' });
    await db.from('project_memberships').insert({ project_id: projectB, actor_subject: GB, role: 'member' });
    R.projects_created = projectA && projectB ? 'PASS' : 'FAIL';

    // 4-6 register Source A under Project A, confirm it lists under A
    const created = await req(`/v1/projects/${projectA}/sources`, 'POST', A_TOKEN, {
      sourceType: 'url',
      title: 'KIP Docs',
      description: 'architecture docs',
      externalUri: 'https://example.com/docs',
    });
    sourceId = created.json?.data?.id;
    R.create = created.status === 201 && sourceId ? 'PASS' : 'FAIL';
    R.create_status_registered = created.json?.data?.status === 'registered' ? 'PASS' : 'FAIL';

    const listA = await req(`/v1/projects/${projectA}/sources`, 'GET', A_TOKEN);
    R.listA_has = (listA.json?.data ?? []).some((s: { id: string }) => s.id === sourceId) ? 'PASS' : 'FAIL';

    // 6-7 does NOT appear under B, and cross-project read must fail
    const listB = await req(`/v1/projects/${projectB}/sources`, 'GET', B_TOKEN);
    R.listB_absent = !(listB.json?.data ?? []).some((s: { id: string }) => s.id === sourceId) ? 'PASS' : 'FAIL';
    const crossGet = await req(`/v1/projects/${projectB}/sources/${sourceId}`, 'GET', B_TOKEN);
    R.cross_get_denied = crossGet.status === 404 || crossGet.status === 403 ? 'PASS' : 'FAIL';

    // 8-9 update title/description
    const upd = await req(`/v1/projects/${projectA}/sources/${sourceId}`, 'PATCH', A_TOKEN, {
      title: 'KIP Docs (v2)',
      description: 'updated desc',
    });
    R.update = upd.json?.data?.title === 'KIP Docs (v2)' ? 'PASS' : 'FAIL';

    // status is NOT client-settable
    const badStatus = await req(`/v1/projects/${projectA}/sources/${sourceId}`, 'PATCH', A_TOKEN, { status: 'ready' });
    R.status_not_editable = badStatus.json?.data?.status === 'registered' ? 'PASS' : 'FAIL';

    // 10-11 archive Source A; archived get still works but it's absent from active list
    const arch = await req(`/v1/projects/${projectA}/sources/${sourceId}`, 'DELETE', A_TOKEN);
    R.archive = arch.json?.data?.status === 'archived' ? 'PASS' : 'FAIL';
    const getAfter = await req(`/v1/projects/${projectA}/sources/${sourceId}`, 'GET', A_TOKEN);
    R.get_archived_ok = getAfter.json?.data?.status === 'archived' ? 'PASS' : 'FAIL';
    const listA2 = await req(`/v1/projects/${projectA}/sources`, 'GET', A_TOKEN);
    R.active_list_excludes_archived = !(listA2.json?.data ?? []).some((s: { id: string }) => s.id === sourceId) ? 'PASS' : 'FAIL';

    // member (guest GB in B) cannot archive; only owner/service
    const gbCreate = await req(`/v1/projects/${projectB}/sources`, 'POST', GB_TOKEN, {
      sourceType: 'url',
      title: 'B source',
      externalUri: 'https://example.com/b',
    });
    const gbSource = gbCreate.json?.data?.id;
    const gbArchive = await req(`/v1/projects/${projectB}/sources/${gbSource}`, 'DELETE', GB_TOKEN);
    R.member_cannot_archive = gbArchive.status === 403 ? 'PASS' : 'FAIL';

    console.log('\n=== SOURCE REGISTRY CLOSURE ===');
    for (const [k, v] of Object.entries(R)) console.log(`${k}: ${v}`);
  } finally {
    if (sourceId) { try { await db.from('sources').delete().eq('id', sourceId); } catch { /* noop */ } }
    try { await db.from('sources').delete().eq('title', 'B source'); } catch { /* noop */ }
    if (projectA) { await db.from('project_memberships').delete().eq('project_id', projectA); await db.from('projects').delete().eq('id', projectA); }
    if (projectB) { await db.from('project_memberships').delete().eq('project_id', projectB); await db.from('projects').delete().eq('id', projectB); }
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((e) => {
  console.error('[src] ERROR:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});