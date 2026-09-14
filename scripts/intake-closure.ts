import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

// Live closure for Knowledge Intake V1 (URL / TEXT / FILE) against the real
// backend, real DB, and the real private storage bucket, using a real session.
const BASE = 'http://localhost:8787';
const EMAIL = 'muslem26@gmail.com';
const PASSWORD = process.env.KIP_DEMO_PASSWORD!;
const SAMPLES = join(process.env.LOCALAPPDATA || process.env.TEMP || '', 'Temp', 'kip-samples');

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = admin as unknown as SupabaseDatabase;
const user = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);
const signIn = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (!signIn.data.session) {
  console.log('SIGNIN_FAIL', signIn.error?.message);
  process.exit(2);
}
const token = signIn.data.session.access_token;
const authHeaders = { authorization: `Bearer ${token}` };

const results: string[] = [];
const mark = (label: string, pass: boolean) => {
  results.push(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  return pass;
};

const project = (await db.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data?.[0];
if (!project) {
  console.log('NO_DEMO_PROJECT');
  process.exit(3);
}

const jsonCall = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> } };
};

const upload = async (file: string, title: string) => {
  const bytes = readFileSync(join(SAMPLES, file));
  const res = await fetch(`${BASE}/v1/projects/${project.id}/sources/file`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-type': file.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      'x-kip-filename': encodeURIComponent(file),
      'x-kip-title': encodeURIComponent(title),
    },
    body: bytes,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> } };
};

// ---- URL -------------------------------------------------------------------
const url = await jsonCall('POST', `/v1/projects/${project.id}/sources`, {
  sourceType: 'url',
  title: 'Example Domain',
  externalUri: 'https://example.com',
});
mark('URL create 201', url.status === 201);
const urlId = url.body.data?.id as string | undefined;

// ---- TEXT ------------------------------------------------------------------
const text = await jsonCall('POST', `/v1/projects/${project.id}/sources/text`, {
  title: 'Shafii Notes',
  content: 'نص تجريبي لملاحظات الشافعي.\n'.repeat(20),
});
mark('TEXT create 201', text.status === 201);
mark('TEXT artifact recorded', text.body.data?.rawArtifact !== undefined);
const textId = text.body.data?.id as string | undefined;

// verify the raw text really persisted
const artifactRow = await db.from('raw_artifacts').select('kind, text_content, content_sha256').eq('source_id', textId!).maybeSingle();
mark('TEXT raw content persisted in DB', typeof artifactRow.data?.text_content === 'string' && (artifactRow.data.text_content as string).includes('نص تجريبي'));

// ---- FILES -----------------------------------------------------------------
const fileIds: string[] = [];
for (const [file, title] of [
  ['kip-sample.pdf', 'Sample PDF'],
  ['kip-sample.docx', 'Sample DOCX'],
  ['kip-sample.txt', 'Sample TXT'],
  ['kip-sample.pptx', 'Sample PPTX'],
] as const) {
  const r = await upload(file, title);
  const ok = r.status === 201;
  mark(`FILE ${file.split('.').pop()!.toUpperCase()} upload 201`, ok);
  if (ok) {
    fileIds.push(r.body.data?.id as string);
    const artifact = r.body.data?.rawArtifact as { originalName?: string; byteSize?: number } | undefined;
    mark(`FILE ${file} artifact metadata`, artifact?.originalName === file && (artifact?.byteSize ?? 0) > 0);
  }
}

// ---- PRIVATE STORAGE VERIFICATION ------------------------------------------
const paths = (await db.from('raw_artifacts').select('storage_bucket, storage_path').eq('project_id', project.id)).data ?? [];
const filePaths = paths.filter((p) => p.storage_bucket === 'kip-raw');
mark('storage rows are bucket=kip-raw', filePaths.length >= 4);
let objectsFound = 0;
for (const p of filePaths) {
  const sp = p.storage_path as string;
  mark(`storage path is project-scoped (${sp.slice(0, 8)}…)`, sp.startsWith(project.id + '/'));
  const dir = sp.slice(0, sp.lastIndexOf('/'));
  const name = sp.slice(sp.lastIndexOf('/') + 1);
  const listed = await admin.storage.from('kip-raw').list(dir);
  if ((listed.data ?? []).some((o) => o.name === name)) objectsFound++;
  // project-scoped directory must contain the source id segment
  mark(`storage path has source segment`, sp.split('/').length === 4);
}
mark('all uploaded objects exist in private storage', objectsFound === filePaths.length && objectsFound >= 4);

// bucket must stay PRIVATE (no public URL resolution)
const buckets = await admin.storage.listBuckets();
const kip = buckets.data?.find((b) => b.name === 'kip-raw');
mark('kip-raw bucket is private', kip?.public === false);

// ---- LIST + ARCHIVE --------------------------------------------------------
const list = await jsonCall('GET', `/v1/projects/${project.id}/sources`);
const rows = (list.body.data ?? []) as unknown as Array<Record<string, unknown>>;
mark('all six sources listed', rows.length >= 6);
mark('list carries no text content', !JSON.stringify(rows).includes('نص تجريبي'));

const arch = await jsonCall('DELETE', `/v1/projects/${project.id}/sources/${textId}`);
mark('ARCHIVE 200', arch.status === 200);
const after = await jsonCall('GET', `/v1/projects/${project.id}/sources`);
const afterRows = (after.body.data ?? []) as unknown as Array<Record<string, unknown>>;
mark('archived source absent from active list', afterRows.every((r) => r.id !== textId));

// ---- ISOLATION -------------------------------------------------------------
const other = (await admin.from('projects').insert({ name: 'KIP Isolation (intake closure)' }).select('id')).data?.[0];
const u = (await (admin.auth as any).admin.listUsers()).data.users.find((x: any) => x.email === EMAIL);
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: u.id, role: 'owner' });
const cross = await jsonCall('GET', `/v1/projects/${other.id}/sources`);
mark('other project sees none of these sources', ((cross.body.data ?? []) as unknown as unknown[]).length === 0);
const crossGet = await jsonCall('GET', `/v1/projects/${other.id}/sources/${urlId}`);
mark('cross-project source read denied', crossGet.status === 404 || crossGet.status === 403);

// ---- CLEANUP (test residue only; persistent demo user/project kept) --------
for (const p of filePaths) await admin.storage.from('kip-raw').remove([p.storage_path as string]).catch(() => {});
await db.from('sources').delete().eq('project_id', project.id);
await db.from('raw_artifacts').delete().eq('project_id', project.id);
await db.from('sources').delete().eq('project_id', other.id);
await db.from('raw_artifacts').delete().eq('project_id', other.id);
await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);

console.log(results.join('\n'));
console.log('ALL_PASS', results.every((r) => r.startsWith('PASS')));
