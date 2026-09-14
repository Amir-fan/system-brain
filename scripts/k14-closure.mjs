// K14 live closure part 1: model assignment, real GitHub embedding, coverage, dimensions.
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.KIP_PUBLIC_API_URL ?? 'http://localhost:8787';
const ADMIN_TOKEN = process.env.KIP_PLATFORM_ADMIN_TOKEN;
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
if (!session.data.session) throw new Error('signin failed');
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };
const A = { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' };

const results = [];
const mark = (l, p) => { results.push((p ? 'PASS ' : 'FAIL ') + l); return p; };
const call = async (m, path, body, headers = H) => {
  const res = await fetch(BASE + path, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const MODEL = 'google/gemini-embedding-001';
const project = (await admin.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data[0];
const source = (await admin.from('sources').select('id,source_type').eq('project_id', project.id).eq('source_type', 'github')).data[0];

// ---------------------------------------------------------------- C. assignment
const put = await call('PUT', '/v1/admin/model-assignments/embeddings', { modelId: MODEL }, A);
mark('C admin assigns the embeddings workload', put.status === 200 && put.body.ok === true);
const listed = await call('GET', '/v1/admin/model-assignments', undefined, A);
const assignment = (listed.body.data?.assignments ?? listed.body.data ?? []).find?.((a) => a.workloadKey === 'embeddings');
mark('C assignment persists after a fresh read', Boolean(assignment) && assignment.modelId === MODEL);
const dbAssign = (await admin.from('model_assignments').select('workload_key, model_id, is_active').eq('workload_key', 'embeddings').maybeSingle()).data;
mark('C assignment is stored in the database', dbAssign?.model_id === MODEL && dbAssign?.is_active === true);

// ---------------------------------------------------------------- D. real embedding
const before = (await admin.from('chunk_embeddings').select('id').eq('source_id', source.id)).data?.length ?? 0;
const t0 = Date.now();
const trigger = await call('POST', `/v1/projects/${project.id}/sources/${source.id}/embeddings`, {});
const elapsed = Date.now() - t0;
mark('D trigger accepted (HTTP 202)', trigger.status === 202 && trigger.body.ok === true);
const jobId = trigger.body.data?.job?.id;
const jobRow = jobId
  ? (await admin.from('embedding_jobs').select('*').eq('id', jobId).maybeSingle()).data
  : null;
mark('D embedding job completed', jobRow?.status === 'completed');
mark('D job carries provider/model/dimensions', jobRow?.provider_key === 'openrouter' && jobRow?.model_id === MODEL && jobRow?.dimensions === 1536);
mark('D provider call really happened (chunks embedded > 0)', (jobRow?.chunks_embedded ?? 0) > 0);
mark('D usage/batching recorded', (jobRow?.batch_count ?? 0) >= 1);
console.log('D job:', JSON.stringify({
  status: jobRow?.status, requested: jobRow?.chunks_requested, embedded: jobRow?.chunks_embedded,
  reused: jobRow?.chunks_reused, batches: jobRow?.batch_count, tokens: jobRow?.input_tokens, ms: elapsed,
}));

// ---------------------------------------------------------------- E. coverage
const snapshot = (await admin.from('ingestion_jobs').select('id').eq('source_id', source.id).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1)).data[0];
const chunks = (await admin.from('document_chunks').select('id').eq('ingestion_job_id', snapshot.id)).data ?? [];
const rows = (await admin
  .from('chunk_embeddings')
  .select('id, chunk_id, model_id, dimensions, embedding, ingestion_job_id')
  .eq('project_id', project.id)
  .eq('ingestion_job_id', snapshot.id)
  .eq('model_id', MODEL)).data ?? [];
const chunkIds = new Set(chunks.map((c) => c.id));
const covered = new Set(rows.map((r) => r.chunk_id));
const missing = [...chunkIds].filter((id) => !covered.has(id));
const dupes = rows.length !== covered.size;
mark('E every chunk of the latest snapshot is embedded', chunks.length > 0 && missing.length === 0);
mark('E no duplicate current rows', !dupes);
console.log('E coverage:', rows.length, '/', chunks.length, '| missing:', missing.length);

// ---------------------------------------------------------------- F. dimensions
const badWidth = rows.filter((r) => {
  const v = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
  return !Array.isArray(v) || v.length !== 1536;
});
mark('F every stored vector is 1536 wide', badWidth.length === 0 && rows.length > 0);
const dims = (await admin.rpc('kip_v1_noop')).data ?? null; // placeholder, real check below via SQL in part 2
mark('F stored rows declare dimensions = 1536', rows.every((r) => r.dimensions === 1536));

globalThis.__ctx = { results, mark, call, admin, user, H, A, BASE, MODEL, project, source, snapshot, chunks, rows, before, jobRow };
console.log('---');
console.log(results.join('\n'));
console.log('PART1_ALL_PASS', results.every((r) => r.startsWith('PASS')));
