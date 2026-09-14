// K12 live closure: canonical documents (text/file/url/github), API, snapshots, atomicity, isolation.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const BASE = 'http://localhost:8787';
const EMAIL = 'muslem26@gmail.com';
const PASSWORD = process.env.KIP_DEMO_PASSWORD;
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (!session.data.session) throw new Error('signin failed');
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };

const results = [];
const mark = (l, p) => { results.push((p ? 'PASS ' : 'FAIL ') + l); return p; };
const call = async (m, path, body) => {
  const res = await fetch(BASE + path, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const project = (await admin.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data[0];
const docsOf = async (jobId) => (await admin.from('documents').select('document_key, normalized_text, content_sha256, char_count, title, logical_path, ordinal, ingestion_job_id').eq('ingestion_job_id', jobId).order('ordinal')).data ?? [];

async function newSource(type, title, payload) {
  if (type === 'text') return (await call('POST', `/v1/projects/${project.id}/sources/text`, { title, content: payload })).body.data?.id;
  if (type === 'url') return (await call('POST', `/v1/projects/${project.id}/sources`, { sourceType: 'url', title, externalUri: payload })).body.data?.id;
  return null;
}
async function uploadTxt(name, title, content) {
  const res = await fetch(`${BASE}/v1/projects/${project.id}/sources/file`, {
    method: 'POST',
    headers: { ...H, 'x-kip-filename': encodeURIComponent(name), 'x-kip-title': encodeURIComponent(title) },
    body: new TextEncoder().encode(content),
  });
  return (await res.json()).data?.id;
}
async function runIngestion(sourceId) {
  const r = await call('POST', `/v1/projects/${project.id}/sources/${sourceId}/ingestions`, {});
  return { status: r.status, job: r.body.data?.job };
}

// ---------------------------------------------------------------- CP1 TEXT
const textContent = 'فقرة أولى\r\n\r\n\r\n\r\nفقرة ثانية';
const textSrc = await newSource('text', 'K12 Text', textContent);
const textRun = await runIngestion(textSrc);
const textDocs = await docsOf(textRun.job.id);
mark('CP1 text ingestion completed', textRun.job?.status === 'completed');
mark('CP1 exactly one canonical document', textDocs.length === 1);
mark('CP1 deterministic key text:primary', textDocs[0]?.document_key === 'text:primary');
const expectedText = 'فقرة أولى\n\nفقرة ثانية';
mark('CP1 normalized content matches the source', textDocs[0]?.normalized_text === expectedText);
mark('CP1 document hash matches its own content', textDocs[0]?.content_sha256 === createHash('sha256').update(expectedText, 'utf8').digest('hex'));
mark('CP1 char count is per document', textDocs[0]?.char_count === Array.from(expectedText).length);

// ---------------------------------------------------------------- CP2 FILE
const fileSrc = await uploadTxt('k12-note.txt', 'K12 TXT', 'ملف نصي\r\n\r\n\r\n\r\nثاني');
const fileRun = await runIngestion(fileSrc);
const fileDocs = await docsOf(fileRun.job.id);
mark('CP2 file ingestion completed', fileRun.job?.status === 'completed');
mark('CP2 exactly one canonical document', fileDocs.length === 1);
mark('CP2 key is file:<name>', fileDocs[0]?.document_key === 'file:k12-note.txt');
mark('CP2 normalized file text correct', fileDocs[0]?.normalized_text === 'ملف نصي\n\nثاني');

// ---------------------------------------------------------------- CP3 URL
const urlSrc = await newSource('url', 'K12 URL', 'https://example.com');
const urlRun = await runIngestion(urlSrc);
const urlDocs = await docsOf(urlRun.job.id);
mark('CP3 url ingestion completed', urlRun.job?.status === 'completed');
mark('CP3 exactly one canonical document', urlDocs.length === 1);
mark('CP3 key is url:primary', urlDocs[0]?.document_key === 'url:primary');
mark('CP3 document text corresponds to the real page', (urlDocs[0]?.normalized_text ?? '').includes('Example Domain'));
mark('CP3 url document hash matches content', urlDocs[0]?.content_sha256 === createHash('sha256').update(urlDocs[0]?.normalized_text ?? '', 'utf8').digest('hex'));

// ---------------------------------------------------------------- CP4 GITHUB multi-document (critical)
const gh = (await admin.from('sources').select('id,title').eq('project_id', project.id).eq('source_type', 'github')).data[0];
const ghRun = await runIngestion(gh.id);
const ghDocs = await docsOf(ghRun.job.id);
mark('CP4 github ingestion completed', ghRun.job?.status === 'completed');
mark('CP4 MULTIPLE canonical documents (not one blob)', ghDocs.length > 1);
console.log('   github documents:', ghDocs.length);
const readme = ghDocs.find((d) => d.document_key === 'github:README.md');
mark('CP4 README.md is its own document', !!readme);
const others = ghDocs.filter((d) => d.document_key !== 'github:README.md' && d.document_key.startsWith('github:'));
mark('CP4 at least one additional repository file is a separate document', others.length >= 1);
console.log('   sample other docs:', others.slice(0, 3).map((d) => d.document_key).join(' | '));
mark('CP4 relative repository paths preserved', ghDocs.every((d) => d.document_key.startsWith('github:') && d.document_key.length > 'github:'.length));
const readmeReal = (await admin.from('documents').select().eq('ingestion_job_id', ghRun.job.id).eq('document_key', 'github:README.md').maybeSingle()).data;
const readmeLine = (readmeReal?.normalized_text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 10) ?? '';
mark('CP4 README text matches real repository content', readmeLine === 'Clean-room baseline.' || readmeLine.startsWith('# KIP Next'));
console.log('   README first meaningful line:', JSON.stringify(readmeLine));
const aggOut = (await admin.from('ingestion_outputs').select('normalized_text, char_count').eq('ingestion_job_id', ghRun.job.id).maybeSingle()).data;
const markerCount = ((aggOut?.normalized_text ?? '').match(/--- FILE: /g) ?? []).length;
// Every canonical document must correspond to a unit inside the aggregate
// representation (and none of them may BE the aggregate - checked below).
const covered = ghDocs.filter((d) => (aggOut?.normalized_text ?? '').includes((d.normalized_text ?? '').slice(0, 60))).length;
mark('CP4 every document maps to a unit of the repository representation', covered === ghDocs.length && ghDocs.length > 1);
console.log('   aggregate markers:', markerCount, '| documents:', ghDocs.length, '| covered:', covered);
mark('CP4 NO document IS the combined repository blob', ghDocs.every((d) => d.char_count !== aggOut?.char_count));
mark('CP4 every github document has its own hash', ghDocs.every((d) => /^[0-9a-f]{64}$/.test(d.content_sha256 ?? '')));

// ---------------------------------------------------------------- CP8 SECRET SAFETY
const allGhText = ghDocs.map((d) => d.normalized_text ?? '').join('\n');
mark('CP8 no secret-like paths among documents', !ghDocs.some((d) => /\.env|\.pem$|\.key$|id_rsa|credentials/i.test(d.document_key)));
// Check the REAL secret material we hold, not fixture strings that merely quote
// token-shaped text (a test file in the repo does that legitimately).
const { readFileSync } = await import('node:fs');
const rawSecret = readFileSync('C:/Users/eminh/KIP-Secrets/kip-gh-client-secret.txt', 'utf8').trim();
const realClientSecret = rawSecret.includes('=') ? rawSecret.slice(rawSecret.lastIndexOf('=') + 1).trim() : rawSecret;
mark('CP8 the real GitHub client secret never appears in documents', realClientSecret.length > 0 && !allGhText.includes(realClientSecret));
mark('CP8 no private key material in documents', !/BEGIN [A-Z ]*PRIVATE KEY/.test(allGhText));
mark('CP8 no live token shape in documents', !/ghs_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{30,}/.test(allGhText));
mark('CP8 no private key files acquired', !allGhText.includes('BEGIN RSA PRIVATE KEY'));

// ---------------------------------------------------------------- CP5 DOCUMENT API
const apiList = await call('GET', `/v1/projects/${project.id}/sources/${gh.id}/documents`);
mark('CP5 source document list works', apiList.status === 200 && (apiList.body.data?.documents ?? []).length === ghDocs.length);
mark('CP5 list does NOT dump normalized content', !(apiList.body.data?.documents ?? []).some((d) => 'normalizedText' in d));
const firstId = (apiList.body.data?.documents ?? [])[0]?.id;
const one = await call('GET', `/v1/projects/${project.id}/documents/${firstId}`);
mark('CP5 single document read returns normalized text', one.status === 200 && typeof one.body.data?.normalizedText === 'string' && one.body.data.normalizedText.length > 0);

// ---------------------------------------------------------------- CP6 RE-INGESTION SNAPSHOTS
const again = await runIngestion(textSrc);
const newDocs = await docsOf(again.job.id);
const oldDocs = await docsOf(textRun.job.id);
mark('CP6 re-ingestion creates a NEW job + snapshot', again.job?.id !== textRun.job?.id && newDocs.length === 1 && newDocs[0].ingestion_job_id === again.job.id);
mark('CP6 previous ingestion documents preserved', oldDocs.length === 1 && oldDocs[0].ingestion_job_id === textRun.job.id);
const latestList = await call('GET', `/v1/projects/${project.id}/sources/${textSrc}/documents`);
mark('CP6 latest view resolves to the newest completed ingestion', latestList.body.data?.ingestionId === again.job.id);
const pinned = await call('GET', `/v1/projects/${project.id}/sources/${textSrc}/documents?ingestionId=${textRun.job.id}`);
mark('CP6 an older snapshot stays addressable by ingestion id', pinned.body.data?.ingestionId === textRun.job.id && (pinned.body.data?.documents ?? []).length === 1);

// ---------------------------------------------------------------- CP9 ISOLATION
const other = (await admin.from('projects').insert({ name: 'K12 Isolation Project' }).select('id')).data[0];
const uid = (await admin.auth.admin.listUsers()).data.users.find((u) => u.email === EMAIL).id;
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: uid, role: 'owner' });
const bList = await call('GET', `/v1/projects/${other.id}/sources/${textSrc}/documents`);
mark('CP9 project B cannot list project A documents', bList.status === 404 || bList.status === 403 || (bList.body.data?.documents ?? []).length === 0);
const bOne = await call('GET', `/v1/projects/${other.id}/documents/${firstId}`);
mark('CP9 project B cannot read project A document', bOne.status === 404 || bOne.status === 403);
mark('CP9 error carries no content', !JSON.stringify(bOne.body).includes('normalizedText'));
await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);

// ---------------------------------------------------------------- cleanup (test residue only)
for (const id of [textSrc, fileSrc, urlSrc]) {
  await admin.from('documents').delete().eq('source_id', id);
  await admin.from('ingestion_outputs').delete().eq('source_id', id);
  await admin.from('ingestion_jobs').delete().eq('source_id', id);
  await admin.from('raw_artifacts').delete().eq('source_id', id);
  await admin.from('sources').delete().eq('id', id);
}
const leftSources = (await admin.from('sources').select('source_type').eq('project_id', project.id)).data ?? [];
mark('CLEANUP only the GitHub source remains (intentional dev data)', leftSources.length === 1 && leftSources[0].source_type === 'github');
mark('CLEANUP isolation project removed', ((await admin.from('projects').select('id').eq('name', 'K12 Isolation Project')).data ?? []).length === 0);

console.log(results.join('\n'));
console.log('ALL_PASS ' + results.every((r) => r.startsWith('PASS')));
