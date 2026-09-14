// K14 live closure part 2: project-scoped reuse, project isolation, assignment change.
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.KIP_PUBLIC_API_URL ?? 'http://localhost:8787';
const ADMIN_TOKEN = process.env.KIP_PLATFORM_ADMIN_TOKEN;
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };
const A = { authorization: 'Bearer ' + ADMIN_TOKEN, 'content-type': 'application/json' };

const results = [];
const mark = (l, p) => { results.push((p ? 'PASS ' : 'FAIL ') + l); return p; };
const call = async (m, path, body, headers = H) => {
  const res = await fetch(BASE + path, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const MODEL = 'google/gemini-embedding-001';
const ALT_MODEL = 'openai/text-embedding-3-large';
const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0];
const source = (await admin.from('sources').select('id').eq('project_id', project.id).eq('source_type', 'github')).data[0];

// ---------------------------------------------------------------- G. same-project reuse
// Reprocess the source: a NEW snapshot with the SAME content hashes. Indexing it must
// reuse the vectors already stored in this project and avoid provider calls entirely.
const priorSnapshot = (await admin.from('ingestion_jobs').select('id').eq('source_id', source.id).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1)).data[0];
const reprocess = await call('POST', `/v1/projects/${project.id}/sources/${source.id}/ingestions`, {});
mark('G reprocess request accepted', reprocess.status >= 200 && reprocess.status < 300);
await new Promise((r) => setTimeout(r, 1500));

const t0 = Date.now();
const reuseRun = await call('POST', `/v1/projects/${project.id}/sources/${source.id}/embeddings`, {});
const reuseMs = Date.now() - t0;
const reuseJob = (await admin.from('embedding_jobs').select('*').eq('id', reuseRun.body.data?.job?.id).maybeSingle()).data;
mark('G reuse run completed', reuseJob?.status === 'completed');
mark('G identical content was reused (chunks_reused > 0)', (reuseJob?.chunks_reused ?? 0) > 0);
mark('G no provider calls were needed (chunks_embedded = 0)', reuseJob?.chunks_embedded === 0);
// Timing is reported, not asserted: the factual claims are reused>0 and embedded=0.
console.log('G reuse latency ms:', reuseMs);
console.log('G reuse:', JSON.stringify({ requested: reuseJob?.chunks_requested, reused: reuseJob?.chunks_reused, embedded: reuseJob?.chunks_embedded, ms: reuseMs }));

// The reuse run must not have raised the project's embedding bill for the same content.
const newSnapshot = (await admin.from('ingestion_jobs').select('id').eq('source_id', source.id).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1)).data[0];
const reuseRows = (await admin.from('chunk_embeddings').select('id, chunk_id').eq('ingestion_job_id', newSnapshot.id).eq('model_id', MODEL)).data ?? [];
const newChunks = (await admin.from('document_chunks').select('id').eq('ingestion_job_id', newSnapshot.id)).data ?? [];
mark('G new snapshot got its own embedding rows', reuseRows.length === newChunks.length && newChunks.length > 0);
mark('G the indexed snapshot is a NEW one', newSnapshot.id !== priorSnapshot.id);

// ---------------------------------------------------------------- H. project isolation
const other = (await admin.from('projects').insert({ name: 'K14 Isolation Project' }).select('id')).data[0];
const uid = (await admin.auth.admin.listUsers()).data.users.find((u) => u.email === 'muslem26@gmail.com').id;
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: uid, role: 'owner' });

const bTrigger = await call('POST', `/v1/projects/${other.id}/sources/${source.id}/embeddings`, {});
const bStatus = await call('GET', `/v1/projects/${other.id}/sources/${source.id}/embeddings`);
const bJob = await call('GET', `/v1/projects/${other.id}/embedding-jobs/${reuseJob.id}`);
mark('H project B cannot trigger project A indexing', bTrigger.status === 403 || bTrigger.status === 404);
mark('H project B cannot read project A index status', bStatus.status === 403 || bStatus.status === 404);
mark('H project B cannot read project A embedding job', bJob.status === 403 || bJob.status === 404);
const refusalBodies = [bTrigger.body, bStatus.body, bJob.body];
mark('H refusals carry no data payload', refusalBodies.every((b) => b && b.ok === false && b.data === undefined));
const leak = JSON.stringify(refusalBodies);
mark('H refusals expose no vectors, counters or model details', !/vector|dimension|chunk|modelId|totalChunks|embeddedChunks/i.test(leak));

await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);

// ---------------------------------------------------------------- J. assignment change
const beforeCount = (await admin.from('chunk_embeddings').select('id').eq('project_id', project.id).eq('model_id', MODEL)).data?.length ?? 0;
const jobsBefore = (await admin.from('embedding_jobs').select('id').eq('project_id', project.id)).data?.length ?? 0;

const switched = await call('PUT', '/v1/admin/model-assignments/embeddings', { modelId: ALT_MODEL }, A);
mark('J assignment switched to another valid embedding model', switched.status === 200 && switched.body.ok === true);

// Give anything automatic a chance to run (there must be nothing).
await new Promise((r) => setTimeout(r, 4000));
const afterCount = (await admin.from('chunk_embeddings').select('id').eq('project_id', project.id).eq('model_id', MODEL)).data?.length ?? 0;
const jobsAfter = (await admin.from('embedding_jobs').select('id').eq('project_id', project.id)).data?.length ?? 0;
mark('J existing embeddings remain untouched', afterCount === beforeCount && beforeCount > 0);
mark('J NO automatic reindex happened', jobsAfter === jobsBefore);

const staleStatus = await call('GET', `/v1/projects/${project.id}/sources/${source.id}/embeddings`);
mark('J system reports that a reindex is needed', staleStatus.body.data?.index?.modelMatches === false);
mark('J reported state is not "ready" for the new model', staleStatus.body.data?.index?.state !== 'ready');

// Restore the approved assignment.
const restored = await call('PUT', '/v1/admin/model-assignments/embeddings', { modelId: MODEL }, A);
mark('J approved assignment restored', restored.status === 200 && restored.body.ok === true);
const finalStatus = await call('GET', `/v1/projects/${project.id}/sources/${source.id}/embeddings`);
mark('J after restore the source reports ready again', finalStatus.body.data?.index?.state === 'ready' && finalStatus.body.data?.index?.modelMatches === true);

console.log('J status:', JSON.stringify({
  content: finalStatus.body.data?.content, index: finalStatus.body.data?.index,
  job: { status: finalStatus.body.data?.job?.status, reused: finalStatus.body.data?.job?.chunksReused },
}));
console.log('---');
console.log(results.join('\n'));
console.log('PART2_ALL_PASS', results.every((r) => r.startsWith('PASS')));
