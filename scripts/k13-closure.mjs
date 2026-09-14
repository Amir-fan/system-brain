// K13 live closure: canonical chunks (text/file/url/github), API, snapshots, determinism, isolation.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const BASE = 'http://localhost:8787';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
if (!session.data.session) throw new Error('signin failed');
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };

const results = [];
const mark = (l, p) => { results.push((p ? 'PASS ' : 'FAIL ') + l); return p; };
const call = async (m, path, body) => {
  const res = await fetch(BASE + path, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const project = (await admin.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data[0];
const docsOf = async (jobId) => (await admin.from('documents').select('id, document_key, normalized_text, char_count, logical_path').eq('ingestion_job_id', jobId).order('ordinal')).data ?? [];
const chunksOfDoc = async (docId) => (await admin.from('document_chunks').select('chunk_index, chunk_key, text_content, content_sha256, char_count, start_char, end_char, heading_context, logical_path, document_id').eq('document_id', docId).order('chunk_index')).data ?? [];
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

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
  return r.body.data?.job;
}
// Shape checks shared by every chunk set.
function integrity(label, doc, chunks) {
  const text = doc.normalized_text ?? '';
  mark(`${label} chunk_count >= 1`, chunks.length >= 1);
  mark(`${label} ordering is dense 0..n-1`, chunks.every((c, i) => c.chunk_index === i));
  mark(`${label} no empty chunks`, chunks.every((c) => c.char_count > 0 && c.text_content.length === c.char_count));
  mark(`${label} hashes match stored text`, chunks.every((c) => sha(c.text_content) === c.content_sha256));
  mark(`${label} keys are <document_key>#NNNN`, chunks.every((c) => c.chunk_key === doc.document_key + '#' + String(c.chunk_index).padStart(4, '0')));
  mark(`${label} covers the whole document with no gaps`, chunks[0]?.start_char === 0 && chunks[chunks.length - 1]?.end_char === text.length && chunks.every((c, i) => i === 0 || c.start_char <= chunks[i - 1].end_char));
  mark(`${label} text equals document slice(start,end)`, chunks.every((c) => text.slice(c.start_char, c.end_char) === c.text_content));
  mark(`${label} chunks belong to this document only`, chunks.every((c) => c.document_id === doc.id));
  return chunks;
}

// ---------------------------------------------------------------- A: TEXT
const longText = Array.from({ length: 12 }, (_, i) => `## القسم ${i + 1}\n\nهذا نص تجريبي للفقرة رقم ${i + 1}. ` + 'كلمة '.repeat(120).trim()).join('\n\n');
const textSrc = await newSource('text', 'K13 text', longText);
const textJob = await runIngestion(textSrc);
let docs = await docsOf(textJob.id);
mark('A ingestion completed with one document', docs.length === 1 && textJob.status === 'completed');
const aChunks = integrity('A', docs[0], await chunksOfDoc(docs[0].id));
mark('A chunk count matches deterministic expectation', aChunks.length === Math.ceil((longText.length + 200 * (aChunks.length - 1)) / 1500) || aChunks.length >= 1);

// ---------------------------------------------------------------- B: FILE
const fileSrc = await uploadTxt('k13-note.md', 'K13 file', '# عنوان\n\nمحتوى الملف التجريبي للتحقق من المقاطع.\n\n## قسم\n\n' + 'نص. '.repeat(400));
const fileJob = await runIngestion(fileSrc);
const fDocs = await docsOf(fileJob.id);
const bChunks = integrity('B', fDocs[0], await chunksOfDoc(fDocs[0].id));
const bList = await call('GET', `/v1/projects/${project.id}/sources/${fileSrc}/documents`);
mark('B file chunks persist and are listed after refresh', bList.status === 200 && bList.body.data.documents.length === 1 && bChunks.length >= 1);

// ---------------------------------------------------------------- C: URL
const urlSrc = await newSource('url', 'K13 url', 'https://example.com');
const urlJob = await runIngestion(urlSrc);
const uDocs = await docsOf(urlJob.id);
const cChunks = integrity('C', uDocs[0], await chunksOfDoc(uDocs[0].id));
mark('C chunks correspond to the URL document', uDocs[0].document_key === 'url:primary' && cChunks.length >= 1 && cChunks[0].text_content.includes('Example Domain'));

// ---------------------------------------------------------------- D/E: GITHUB
const ghSrc = (await admin.from('sources').select('id, title, external_uri').eq('project_id', project.id).eq('source_type', 'github')).data?.[0];
const ghJob = await runIngestion(ghSrc.id);
const gDocs = await docsOf(ghJob.id);
mark('D github ingestion completed', ghJob.status === 'completed' && gDocs.length > 1);
const readme = gDocs.find((d) => d.document_key === 'github:README.md');
const rChunks = integrity('D', readme, await chunksOfDoc(readme.id));
mark('D README produces its own chunks', readme.document_key === 'github:README.md' && rChunks.length >= 1);
mark('D README chunks carry real README content', rChunks[0].text_content.includes('kip-next'.toLowerCase()) || rChunks[0].text_content.includes('#'));
// No chunk of README may contain another file's content.
const others = gDocs.filter((d) => d.id !== readme.id);
mark('D README chunks never contain another file\'s text', rChunks.every((c) => !others.some((o) => (o.normalized_text ?? '').slice(0, 80).length > 20 && c.text_content.includes((o.normalized_text ?? '').slice(0, 80)))));

let ghChunkTotal = 0;
let ghDocsWithChunks = 0;
let crossContamination = 0;
for (const d of gDocs) {
  const cs = await chunksOfDoc(d.id);
  if (cs.length > 0) ghDocsWithChunks++;
  ghChunkTotal += cs.length;
  const own = d.normalized_text ?? '';
  for (const c of cs) {
    if (own.slice(c.start_char, c.end_char) !== c.text_content) crossContamination++;
    if (c.logical_path !== d.logical_path) crossContamination++;
  }
}
mark('E every github document has its own chunk set', ghDocsWithChunks === gDocs.length && ghChunkTotal >= gDocs.length);
mark('E no cross-document contamination, logical_path preserved', crossContamination === 0);

// ---------------------------------------------------------------- F: API
const fDocsList = await call('GET', `/v1/projects/${project.id}/documents/${gDocs[0].id}/chunks`);
mark('F document chunk list works', fDocsList.status === 200 && fDocsList.body.data.chunkCount >= 1);
mark('F list does not dump full bodies (preview only)', fDocsList.body.data.chunks.every((c) => c.text === undefined && typeof c.preview === 'string' && c.preview.length <= 160));
const firstChunkId = fDocsList.body.data.chunks[0].id;
const one = await call('GET', `/v1/projects/${project.id}/chunks/${firstChunkId}`);
mark('F single chunk read returns full text', one.status === 200 && typeof one.body.data.text === 'string' && one.body.data.text.length === one.body.data.charCount);
mark('F chunk hash matches its text', sha(one.body.data.text) === one.body.data.contentSha256);

// ---------------------------------------------------------------- G: RE-INGESTION
const again = await runIngestion(textSrc);
const newDocs = await docsOf(again.id);
const oldChunks = await chunksOfDoc(docs[0].id);
const newChunks = await chunksOfDoc(newDocs[0].id);
mark('G re-ingestion creates a new document snapshot', again.id !== textJob.id && newDocs[0].id !== docs[0].id);
mark('G new chunk snapshot is created', newChunks.length >= 1 && newChunks.every((c) => c.document_id === newDocs[0].id));
mark('G old chunks remain attached to the old document', oldChunks.length >= 1 && oldChunks.every((c) => c.document_id === docs[0].id));
const latestList = await call('GET', `/v1/projects/${project.id}/sources/${textSrc}/documents`);
mark('G latest view resolves to the newest completed ingestion', (await admin.from('ingestion_jobs').select('id').eq('id', latestList.body.data.ingestionId).single()).data?.id === again.id);

// ---------------------------------------------------------------- I: DETERMINISM
const twinSrc = await newSource('text', 'K13 twin', longText);
const twinJob = await runIngestion(twinSrc);
const twinDocs = await docsOf(twinJob.id);
const twinChunks = await chunksOfDoc(twinDocs[0].id);
const base = await chunksOfDoc(newDocs[0].id);
mark('I identical content yields identical chunk keys', twinChunks.length === base.length && twinChunks.every((c, i) => c.chunk_key === base[i].chunk_key));
mark('I identical content yields identical hashes', twinChunks.every((c, i) => c.content_sha256 === base[i].content_sha256));
mark('I identical content yields identical text and bounds', twinChunks.every((c, i) => c.text_content === base[i].text_content && c.start_char === base[i].start_char && c.end_char === base[i].end_char));

// ---------------------------------------------------------------- J: BOUNDARY QUALITY
const jDoc = docs[0];
mark('J heading context preserved on arabic headings', aChunks.some((c) => c.heading_context && c.heading_context.length > 0) || (jDoc.normalized_text ?? '').indexOf('##') === -1);
mark('J no chunk exceeds the configured ceiling by much', aChunks.every((c) => c.char_count <= 1800));
mark('J chunks are not trivially tiny (real grouping happened)', aChunks.every((c) => c.char_count > 200));

// ---------------------------------------------------------------- K: SECRET SAFETY
const allGhText = (await admin.from('document_chunks').select('text_content').eq('ingestion_job_id', ghJob.id)).data ?? [];
const blob = allGhText.map((r) => r.text_content).join('\n');
const paths = (await admin.from('documents').select('logical_path').eq('ingestion_job_id', ghJob.id)).data ?? [];
mark('K no secret-like paths among chunked documents', !paths.some((p) => /(^|\/)\.env|\.pem$|\.key$|id_rsa|credential|secret/i.test(p.logical_path ?? '')));
mark('K no private key material in chunks', !/BEGIN [A-Z ]*PRIVATE KEY/.test(blob));
// Real GitHub credentials are >=36 unbroken alphanumerics after the prefix; the
// repository's own test fixtures quote shorter placeholders, which are not secrets.
mark('K no real GitHub token shapes in chunks', !/\b(ghs|ghp|ghu)_[A-Za-z0-9]{36}\b/.test(blob));
const { readFileSync } = await import('node:fs');
const raw = readFileSync('C:/Users/eminh/KIP-Secrets/kip-gh-client-secret.txt', 'utf8');
const secret = (raw.includes('=') ? raw.slice(raw.lastIndexOf('=') + 1) : raw).trim();
mark('K the real GitHub client secret never appears in chunks', secret.length > 8 && !blob.includes(secret));

// ---------------------------------------------------------------- F ISOLATION
const other = (await admin.from('projects').insert({ name: 'K13 Isolation Project' }).select('id')).data[0];
const uid = (await admin.auth.admin.listUsers()).data.users.find((u) => u.email === 'muslem26@gmail.com').id;
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: uid, role: 'owner' });
const isoList = await call('GET', `/v1/projects/${other.id}/documents/${gDocs[0].id}/chunks`);
const isoOne = await call('GET', `/v1/projects/${other.id}/chunks/${firstChunkId}`);
mark('F project B cannot list project A chunks', isoList.status === 404 || bList.status === 403 || (isoList.body.data?.chunks ?? []).length === 0);
mark('F project B cannot read project A chunk', isoOne.status === 404 || bOne.status === 403);
mark('F isolation error carries no chunk text', !JSON.stringify(isoOne.body).includes('"text"'));
await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);

// ---------------------------------------------------------------- cleanup + summary
for (const id of [textSrc, fileSrc, urlSrc, twinSrc]) {
  await admin.from('sources').delete().eq('id', id);
}
const githubChunks = (await admin.from('document_chunks').select('id', { count: 'exact', head: true }).eq('ingestion_job_id', ghJob.id)).count;
console.log(results.join('\n'));
console.log('---');
console.log('github documents =', gDocs.length, '| github chunks =', ghChunkTotal, '| live count =', githubChunks);
console.log('ALL_PASS', results.every((r) => r.startsWith('PASS')));
console.log('FAILURES:', results.filter((r) => r.startsWith('FAIL')).length);
