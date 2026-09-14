// Live closure for K10 ingestion (real Supabase + real backend + real auth).
// Prints PASS/FAIL lines only - never source contents or secrets.
import { createClient } from '@supabase/supabase-js';

const BASE = 'http://localhost:8787';
const EMAIL = 'muslem26@gmail.com';
const PASSWORD = process.env.KIP_DEMO_PASSWORD;

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const signIn = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (!signIn.data.session) throw new Error('signin failed');
const token = signIn.data.session.access_token;
const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

const results = [];
const mark = (label, pass) => {
  results.push((pass ? 'PASS ' : 'FAIL ') + label);
  return pass;
};
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const project = (await admin.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data[0];
console.log('project:', project.name);

// ---------------------------------------------------------------- CP1/CP2: text
const created = await call('POST', `/v1/projects/${project.id}/sources/text`, {
  title: 'K10 Text Source',
  content: 'السطر الأول\r\n\r\n\r\n\r\nالسطر الثاني  \n\n\n',
});
mark('CP1 text source created (201)', created.status === 201);
const textSourceId = created.body.data?.id;

const ingest = await call('POST', `/v1/projects/${project.id}/sources/${textSourceId}/ingestions`, {});
mark('CP1 ingest 201', ingest.status === 201);
const job = ingest.body.data?.job;
mark('CP1 job completed', job?.status === 'completed');
mark('CP1 attempt_number = 1', job?.attemptNumber === 1);
mark('CP1 trigger_type = manual', job?.triggerType === 'manual');
mark('CP1 output summary present (charCount + hash)', typeof ingest.body.data?.output?.charCount === 'number' && /^[0-9a-f]{64}$/.test(ingest.body.data?.output?.contentSha256 ?? ''));

// DB proof: job row + output row really persisted with the right transitions
const jobRow = (await admin.from('ingestion_jobs').select('status, started_at, completed_at, failed_at, attempt_number, trigger_type').eq('id', job.id).maybeSingle()).data;
mark('CP1 DB job row completed with started+completed and no failed_at', jobRow?.status === 'completed' && !!jobRow?.started_at && !!jobRow?.completed_at && jobRow?.failed_at === null);

const outRow = (await admin.from('ingestion_outputs').select('normalized_text, content_sha256, char_count').eq('ingestion_job_id', job.id).maybeSingle()).data;
const expectedNormalized = 'السطر الأول\n\nالسطر الثاني';
mark('CP1 DB normalized text matches the real pasted source', outRow?.normalized_text === expectedNormalized);
const { createHash } = await import('node:crypto');
mark('CP1 DB hash matches sha256(normalized)', outRow?.content_sha256 === createHash('sha256').update(expectedNormalized, 'utf8').digest('hex'));
mark('CP1 char_count persisted', outRow?.char_count === Array.from(expectedNormalized).length);

// CP2: fetch endpoints
const bySource = await call('GET', `/v1/projects/${project.id}/sources/${textSourceId}/ingestions`);
mark('CP2 list by source returns the job', bySource.status === 200 && bySource.body.data?.length === 1);
const byId = await call('GET', `/v1/projects/${project.id}/ingestions/${job.id}`);
mark('CP2 get by id', byId.status === 200 && byId.body.data?.id === job.id);
const byProject = await call('GET', `/v1/projects/${project.id}/ingestions`);
mark('CP2 project list exposes latest job per source (no raw content)', byProject.status === 200 && !JSON.stringify(byProject.body.data).includes('السطر'));

// ---------------------------------------------------------------- CP4: file (TXT via private storage)
const txt = new TextEncoder().encode('ملف نصي\r\n\r\n\r\n\r\nثاني فقرة');
const up = await fetch(`${BASE}/v1/projects/${project.id}/sources/file`, {
  method: 'POST',
  headers: { ...H, 'x-kip-filename': encodeURIComponent('k10-note.txt'), 'x-kip-title': encodeURIComponent('K10 TXT Source') },
  body: txt,
});
const upBody = await up.json();
mark('CP4 TXT uploaded (201)', up.status === 201);
const fileSourceId = upBody.data?.id;

const fileIngest = await call('POST', `/v1/projects/${project.id}/sources/${fileSourceId}/ingestions`, {});
mark('CP4 file ingest completed', fileIngest.status === 201 && fileIngest.body.data?.job?.status === 'completed');
const fileOut = (await admin.from('ingestion_outputs').select('normalized_text').eq('source_id', fileSourceId).maybeSingle()).data;
mark('CP4 normalized text read from PRIVATE storage matches', fileOut?.normalized_text === 'ملف نصي\n\nثاني فقرة');

// ---------------------------------------------------------------- CP6: idempotency
// DB-enforced guard: a second ACTIVE job for the same source must be rejected.
const dup = await admin.from('ingestion_jobs').insert([
  { project_id: project.id, source_id: textSourceId, status: 'queued', attempt_number: 99, trigger_type: 'manual', created_by_subject: 'x' },
]);
const firstInsert = !dup.error;
let secondInsert = false;
if (firstInsert) {
  const dup2 = await admin.from('ingestion_jobs').insert([
    { project_id: project.id, source_id: textSourceId, status: 'queued', attempt_number: 100, trigger_type: 'manual', created_by_subject: 'x' },
  ]);
  secondInsert = !dup2.error;
  await admin.from('ingestion_jobs').delete().eq('attempt_number', 99).eq('source_id', textSourceId);
}
mark('CP6 DB partial unique index rejects a second active job', firstInsert && !secondInsert);

// rapid double trigger never leaves two active jobs
const rapid = await Promise.all([
  call('POST', `/v1/projects/${project.id}/sources/${fileSourceId}/ingestions`, {}),
  call('POST', `/v1/projects/${project.id}/sources/${fileSourceId}/ingestions`, {}),
]);
const activeCount = (await admin.from('ingestion_jobs').select('id').eq('source_id', fileSourceId).in('status', ['queued', 'processing'])).data?.length ?? -1;
mark('CP6 rapid double trigger leaves at most one active job', rapid.every((r) => r.status === 200 || r.status === 201) && activeCount <= 1);
mark('CP6 reuse is reported deterministically when a job is active', rapid.some((r) => r.body.data?.reused === true) || activeCount === 0);

// ---------------------------------------------------------------- CP7: failure + retry
const failSrc = await call('POST', `/v1/projects/${project.id}/sources/text`, {
  title: 'K10 Failure Source',
  content: 'سيُحذف المحتوى الأصلي لإحداث فشل',
});
const failSourceId = failSrc.body.data?.id;
// Remove the raw artifact WITHOUT touching the source -> deterministic failure.
await admin.from('raw_artifacts').delete().eq('source_id', failSourceId);

const failedIngest = await call('POST', `/v1/projects/${project.id}/sources/${failSourceId}/ingestions`, {});
const failJob = failedIngest.body.data?.job;
mark('CP7 job reaches failed state', failedIngest.status === 201 && failJob?.status === 'failed');
mark('CP7 failure code is RAW_ARTIFACT_MISSING', failJob?.errorCode === 'RAW_ARTIFACT_MISSING');
const failRow = (await admin.from('ingestion_jobs').select('status, failed_at, error_code, error_message').eq('id', failJob.id).maybeSingle()).data;
mark('CP7 failure persisted safely (code + message, no raw content)',
  failRow?.status === 'failed' && !!failRow?.failed_at && failRow?.error_code === 'RAW_ARTIFACT_MISSING' &&
  typeof failRow?.error_message === 'string' && !failRow.error_message.includes('سيُحذف'));
mark('CP7 no output row for a failed job', ((await admin.from('ingestion_outputs').select('id').eq('ingestion_job_id', failJob.id)).data?.length ?? -1) === 0);

// restore the original material, then retry
await admin.from('raw_artifacts').insert({
  project_id: project.id, source_id: failSourceId, kind: 'text',
  text_content: 'استُعيد المحتوى الأصلي', mime_type: 'text/plain',
});
const retried = await call('POST', `/v1/projects/${project.id}/ingestions/${failJob.id}/retry`, {});
mark('CP7 retry creates attempt 2 and succeeds', retried.status === 201 && retried.body.data?.job?.attemptNumber === 2 && retried.body.data?.job?.status === 'completed');
mark('CP7 retry trigger recorded', retried.body.data?.job?.triggerType === 'retry');

// ---------------------------------------------------------------- CP5: project isolation
const other = (await admin.from('projects').insert({ name: 'K10 Isolation Project' }).select('id')).data[0];
const uid = (await admin.auth.admin.listUsers()).data.users.find((u) => u.email === EMAIL).id;
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: uid, role: 'owner' });

const crossIngest = await call('POST', `/v1/projects/${other.id}/sources/${textSourceId}/ingestions`, {});
mark('CP5 project B cannot trigger ingestion for project A source', crossIngest.status === 404 || crossIngest.status === 403);
const crossGet = await call('GET', `/v1/projects/${other.id}/ingestions/${job.id}`);
mark('CP5 project B cannot read project A ingestion', crossGet.status === 404 || crossGet.status === 403);
const crossRetry = await call('POST', `/v1/projects/${other.id}/ingestions/${job.id}/retry`, {});
mark('CP5 project B cannot retry project A job', crossRetry.status === 404 || crossRetry.status === 403);
const bList = await call('GET', `/v1/projects/${other.id}/ingestions`);
mark('CP5 project B sees none of A ingestions', bList.status === 200 && bList.body.data?.length === 0);

// ---------------------------------------------------------------- cleanup (test residue only)
const bSources = (await admin.from('sources').select('id').eq('project_id', other.id)).data ?? [];
for (const s of bSources) await admin.from('sources').delete().eq('id', s.id);
await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);

for (const s of [textSourceId, fileSourceId, failSourceId]) {
  await admin.from('ingestion_outputs').delete().eq('source_id', s);
  await admin.from('ingestion_jobs').delete().eq('source_id', s);
  await admin.from('raw_artifacts').delete().eq('source_id', s);
  await admin.from('sources').delete().eq('id', s);
}
const residue = {
  sources: (await admin.from('sources').select('id').eq('project_id', project.id)).data?.length ?? -1,
  jobs: (await admin.from('ingestion_jobs').select('id').eq('project_id', project.id)).data?.length ?? -1,
  outputs: (await admin.from('ingestion_outputs').select('id').eq('project_id', project.id)).data?.length ?? -1,
  projects: (await admin.from('projects').select('id').eq('name', 'K10 Isolation Project')).data?.length ?? -1,
};
mark('CLEANUP zero residue (sources/jobs/outputs/isolation project)', residue.sources === 0 && residue.jobs === 0 && residue.outputs === 0 && residue.projects === 0);

console.log(results.join('\n'));
console.log('ALL_PASS ' + results.every((r) => r.startsWith('PASS')));
