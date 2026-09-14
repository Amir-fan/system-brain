// K15 setup: add one REAL Arabic knowledge source through the real pipeline (URL -> documents -> chunks -> embeddings).
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.KIP_PUBLIC_API_URL ?? 'http://localhost:8787';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };
const call = async (m, path, body) => {
  const res = await fetch(BASE + path, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0];
const URL_AR = 'https://ar.wikipedia.org/wiki/%D8%B0%D9%83%D8%A7%D8%A1_%D8%A7%D8%B5%D8%B7%D9%86%D8%A7%D8%B9%D9%8A';

const existing = (await admin.from('sources').select('id, title').eq('project_id', project.id).eq('external_uri', URL_AR)).data?.[0];
let sourceId = existing?.id;
if (!sourceId) {
  const created = await call('POST', `/v1/projects/${project.id}/sources`, {
    sourceType: 'url',
    title: 'الذكاء الاصطناعي (ويكيبيديا)',
    externalUri: URL_AR,
  });
  sourceId = created.body.data?.id;
  console.log('created source:', sourceId, '| status:', created.status);
} else {
  console.log('reusing source:', sourceId);
}

const ingest = await call('POST', `/v1/projects/${project.id}/sources/${sourceId}/ingestions`, {});
console.log('ingestion:', ingest.status, JSON.stringify(ingest.body.data?.job?.status ?? ingest.body.error ?? {}).slice(0, 160));

const snapshot = (await admin.from('ingestion_jobs').select('id, status').eq('source_id', sourceId).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1)).data?.[0];
const chunks = (await admin.from('document_chunks').select('id, char_count').eq('ingestion_job_id', snapshot.id)).data ?? [];
const docs = (await admin.from('documents').select('logical_path, char_count').eq('ingestion_job_id', snapshot.id)).data ?? [];
console.log('snapshot:', snapshot.id, '| documents:', docs.length, '| chunks:', chunks.length, '| chars:', docs.reduce((s, d) => s + d.char_count, 0));
console.log('paths:', JSON.stringify(docs.map((d) => d.logical_path)));

const index = await call('POST', `/v1/projects/${project.id}/sources/${sourceId}/embeddings`, {});
console.log('indexing:', index.status, JSON.stringify(index.body.data?.job ?? index.body.error).slice(0, 200));
