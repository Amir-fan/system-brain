import { createClient } from '@supabase/supabase-js';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

// Functional closure for Source Registry UI V1: exercises the exact endpoints the
// UI calls, with a REAL Supabase session token, through the real backend.
const EMAIL = 'muslem26@gmail.com';
const PASSWORD = process.env.KIP_DEMO_PASSWORD!;
const BASE = 'http://localhost:8787';

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const db = admin as unknown as SupabaseDatabase;
const c = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);
const { data: s } = await c.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
const tok = s!.session!.access_token;
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
const call = async (m: string, p: string, body?: unknown) => {
  const r = await fetch(BASE + p, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const A = (await db.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data![0];

// Project B (isolation test) — created via admin harness, cleaned at the end.
const B = (await admin.from('projects').insert({ name: 'KIP Isolation Project (closure)' }).select('id')).data![0];
const user = (await (admin.auth as any).admin.listUsers()).data.users.find((u: any) => u.email === EMAIL);
await admin.from('project_memberships').insert({ project_id: B.id, actor_subject: user.id, role: 'owner' });

const R: string[] = [];
const mark = (label: string, pass: boolean) => R.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);

// CREATE in A
const created = await call('POST', `/v1/projects/${A.id}/sources`, { sourceType: 'url', title: 'Example Domain', externalUri: 'https://example.com', description: 'closure' });
mark('create(A) 201', created.status === 201);
const sid = created.json.data?.id;

// Refresh persistence
const afterCreate = await call('GET', `/v1/projects/${A.id}/sources`);
mark('persists after refetch', afterCreate.json.data?.some((x: any) => x.id === sid && x.title === 'Example Domain'));

// EDIT
const edited = await call('PATCH', `/v1/projects/${A.id}/sources/${sid}`, { title: 'Example Domain (edited)', description: 'edited desc' });
mark('edit 200', edited.status === 200);
const afterEdit = await call('GET', `/v1/projects/${A.id}/sources`);
mark('edit persists', afterEdit.json.data?.some((x: any) => x.id === sid && x.title === 'Example Domain (edited)'));

// ISOLATION: B has no view of A's source
const bList = await call('GET', `/v1/projects/${B.id}/sources`);
mark('B does not see A source', bList.status === 200 && !bList.json.data.some((x: any) => x.id === sid));
const cross = await call('GET', `/v1/projects/${B.id}/sources/${sid}`);
mark('cross-project get blocked', cross.status === 404 || cross.status === 403);

// ARCHIVE
const arch = await call('DELETE', `/v1/projects/${A.id}/sources/${sid}`);
mark('archive 200', arch.status === 200);
const afterArch = await call('GET', `/v1/projects/${A.id}/sources`);
mark('archived absent from active list', afterArch.json.data?.every((x: any) => x.id !== sid));

// Clean isolation project residue (persistent demo project/user untouched)
await admin.from('sources').delete().eq('project_id', B.id);
await admin.from('project_memberships').delete().eq('project_id', B.id);
await admin.from('projects').delete().eq('id', B.id);
// archive the demo project's test source content too
await db.from('sources').delete().eq('project_id', A.id);

console.log(R.join('\n'));
console.log('ALL_PASS', R.every((x) => x.startsWith('PASS')));