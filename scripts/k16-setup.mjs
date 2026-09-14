// K16 setup: assign the answer model, and create a controlled CONFLICT fixture source.
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.KIP_PUBLIC_API_URL ?? 'http://localhost:8787';
const ADMIN = { authorization: 'Bearer ' + process.env.KIP_PLATFORM_ADMIN_TOKEN, 'content-type': 'application/json' };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };
const call = async (m, path, body, headers = H) => {
  const res = await fetch(BASE + path, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const MODEL = 'google/gemini-3.5-flash';
const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0];

// 1. answer model assignment (explicit, no fallback)
const put = await call('PUT', '/v1/admin/model-assignments/knowledge_answer', { modelId: MODEL }, ADMIN);
console.log('assignment:', put.status, JSON.stringify(put.body.data ?? put.body.error));
const listed = await call('GET', '/v1/admin/model-assignments', undefined, ADMIN);
const rows = listed.body.data?.assignments ?? listed.body.data ?? [];
console.log('assignments now:', JSON.stringify(rows));

// 2. controlled conflict fixture: two sections of ONE real document stating different retention periods.
const FIXTURE_TITLE = 'سياسة الاحتفاظ بالبيانات (اختبار تعارض)';
const FIXTURE = [
  'سياسة الاحتفاظ بالبيانات في المنصة',
  '',
  'تنص النسخة الأولى من السياسة على أن مدة الاحتفاظ ببيانات المشروع هي 30 يومًا من تاريخ آخر نشاط.',
  'وتنص النسخة الثانية المنشورة لاحقًا على أن مدة الاحتفاظ ببيانات المشروع هي 90 يومًا من تاريخ آخر نشاط.',
  'هذا المستند أُنشئ لاختبار كشف التعارض في المعرفة، ويحتوي عن قصد على بيانين متعارضين للمدة نفسها.',
].join('\n');

const existing = (await admin.from('sources').select('id').eq('project_id', project.id).eq('title', FIXTURE_TITLE)).data?.[0];
let sourceId = existing?.id;
if (!sourceId) {
  const created = await call('POST', `/v1/projects/${project.id}/sources/text`, { title: FIXTURE_TITLE, content: FIXTURE });
  sourceId = created.body.data?.id;
  console.log('fixture source:', sourceId, created.status);
} else {
  console.log('fixture source (existing):', sourceId);
}
const ingest = await call('POST', `/v1/projects/${project.id}/sources/${sourceId}/ingestions`, {});
console.log('fixture ingestion:', ingest.status, ingest.body.data?.job?.status);
const index = await call('POST', `/v1/projects/${project.id}/sources/${sourceId}/embeddings`, {});
console.log('fixture indexing:', index.status, JSON.stringify(index.body.data?.job?.status ?? index.body.error));
