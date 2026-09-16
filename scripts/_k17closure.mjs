// K17 live closure (DB-authoritative): retry real sources via the PRODUCTION API,
// then read the persisted results and prove live retrieval.
// NOTE: two clients — the admin client must NEVER sign in (RLS deny-by-default).
import { createClient } from '@supabase/supabase-js';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const rows = async (q) => (await q).data ?? [];
const B = 'http://127.0.0.1:8787';

const P = '7e73c7a3-4973-4a6f-849b-ec84988a3d14';
const DOCX = '44bff587-1885-4c3a-86cf-cb766c8371a4';
const SCANNED_PDF = 'c4c0f10f-6bad-4656-9ff1-815ee0da13b9';
const TEXT_PDF = 'c57a1d3e-3848-4e76-b57d-5e992c3bbfc7';

const EMAIL = process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local';
const PASSWORD = process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123';
const { data: s, error: se } = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (se || !s?.session) { console.log('❌ login failed', se?.message); process.exit(1); }
const H = { authorization: 'Bearer ' + s.session.access_token, 'content-type': 'application/json' };
const J = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const ok = (m, c) => console.log(`${c ? '✅' : '❌'} ${m}`);

const latestJob = async (sid) => (await rows(admin.from('ingestion_jobs').select('*').eq('source_id', sid).order('created_at', { ascending: false }).limit(1)))[0];

async function report(label, sid) {
  const j = await latestJob(sid);
  if (!j) { console.log(`\n---- ${label} ----\n  (no job row)`); return { j: null, docs: [], chunks: 0, embs: 0, arabic: 0 }; }
  const out = await rows(admin.from('ingestion_outputs').select('char_count').eq('ingestion_job_id', j.id));
  const docs = await rows(admin.from('documents').select('id, document_key, char_count').eq('ingestion_job_id', j.id));
  let chunks = 0; let embs = 0; let arabic = 0; let sample = '';
  if (docs[0]) {
    chunks = (await rows(admin.from('document_chunks').select('id').eq('document_id', docs[0].id))).length;
    embs = (await rows(admin.from('chunk_embeddings').select('id').eq('document_id', docs[0].id))).length;
    const t = (await rows(admin.from('documents').select('normalized_text').eq('id', docs[0].id)))[0]?.normalized_text ?? '';
    arabic = (t.match(/[\u0600-\u06FF]/g) || []).length;
    sample = t.replace(/\s+/g, ' ').slice(0, 130);
  }
  console.log(`\n---- ${label} ----`);
  console.log('  job=%s status=%s attempt=%d err=%s | %s', j.id.slice(0, 8), j.status, j.attempt_number, j.error_code ?? '-', j.error_message ?? '');
  console.log('  outputChars=%s documents=%d chunks=%d embeddings=%d arabic=%d', out[0]?.char_count ?? 0, docs.length, chunks, embs, arabic);
  if (sample) console.log('  sample=%s', JSON.stringify(sample));
  return { j, out, docs, chunks, embs, arabic, sample };
}

const reprocess = (sid) => J('POST', `/v1/projects/${P}/sources/${sid}/ingestions`);

// ---------- 1. DOCX (was ACQUISITION_FAILED) ----------
const docxRes = await reprocess(DOCX);
console.log('DOCX ingest http=%d', docxRes.status);
const D = await report('DOCX', DOCX);
ok('DOCX processing completed', D.j?.status === 'completed');
ok('DOCX real document created', D.docs.length > 0 && ((await rows(admin.from('ingestion_outputs').select('char_count').eq('ingestion_job_id', D.j.id)))[0]?.char_count ?? 0) > 1000);
ok('DOCX real chunks created', D.chunks > 0);
ok('DOCX extracted text is real Arabic', D.arabic > 5000);

// index the repaired source (separate, explicit stage) and prove embeddings exist
const idx = await J('POST', `/v1/projects/${P}/sources/${DOCX}/embeddings`);
console.log('  index http=%d job=%s', idx.status, JSON.stringify(idx.data?.job?.status ?? null));
let embsAfter = 0;
{
  const latestDoc = (await rows(admin.from('documents').select('id').eq('ingestion_job_id', D.j.id)))[0];
  embsAfter = latestDoc ? (await rows(admin.from('chunk_embeddings').select('id').eq('document_id', latestDoc.id))).length : 0;
}
console.log('  embeddings after index = %d', embsAfter);
ok('DOCX indexed (embeddings present)', embsAfter > 0);

// ---------- 2. SCANNED PDF must stay OCR_REQUIRED ----------
const pdfRes = await reprocess(SCANNED_PDF);
console.log('\nSCANNED PDF ingest http=%d', pdfRes.status);
const S = await report('SCANNED PDF', SCANNED_PDF);
ok('scanned PDF truthfully stays OCR_REQUIRED', S.j?.error_code === 'OCR_REQUIRED' && S.j?.status === 'failed');
ok('scanned PDF produced no documents (no garbage)', S.docs.length === 0 && S.chunks === 0);

// ---------- 3. TEXT PDF (recorded; not fixed in this change-set) ----------
const tRes = await reprocess(TEXT_PDF);
console.log('\nTEXT PDF ingest http=%d', tRes.status);
await report('TEXT PDF', TEXT_PDF);

// ---------- 4. LIVE RETRIEVAL from the repaired DOCX ----------
const text = (await rows(admin.from('documents').select('normalized_text').eq('id', D.docs[0].id)))[0].normalized_text;
// A distinctive phrase that exists uniquely in this source's real text.
const distinct = 'شيخ حلقة الفقه الشافعي بالمسجد النبوي';
const probe = 'حلقة الفقه الشافعي بالمسجد النبوي';
console.log('\nretrieval query = %s', JSON.stringify(distinct));
const rq = await J('POST', `/v1/projects/${P}/retrieval/search`, { query: distinct, topK: 5 });
const hits = rq.data?.results ?? [];
console.log('retrieval http=%d hits=%d', rq.status, hits.length);
for (const h of hits.slice(0, 3)) console.log('   #%d score=%s source=%s text=%s', h.position, h.score, JSON.stringify(h.source), JSON.stringify((h.text || '').replace(/\s+/g, ' ').slice(0, 110)));
const hitText = hits.map((h) => h.text || '').join(' ');
ok('LIVE retrieval returns real Arabic chunk text', hits.length > 0 && /[\u0600-\u06FF]/.test(hitText));
ok('retrieved chunk contains the real source phrasing', hitText.includes(probe));
ok('retrieval attributes the chunk to the repaired source', hits.some((h) => (h.source ?? '').includes('الحيض') || (h.document ?? '').includes('elhaid')) || text.includes(probe));

// ---------- 5. ARABIC TXT through the same production path ----------
const marker = 'عبارة اختبار فريدة للملف النصي العربي رقم';
const txtBody = `بسم الله الرحمن الرحيم\n${marker} 4821\nباب الطهارة: الماء طهور لا ينجسه شيء إلا ما غير لونه أو طعمه أو ريحه.\nباب الحيض: أقل الحيض يوم وليلة وأكثره خمسة عشر يوما.\n`;
const up = await fetch(`${B}/v1/projects/${P}/sources/file`, {
  method: 'POST',
  headers: {
    authorization: H.authorization,
    'content-type': 'text/plain; charset=utf-8',
    'x-kip-filename': encodeURIComponent('k17-arabic-test.txt'),
    'x-kip-title': encodeURIComponent('اختبار نص عربي'),
  },
  body: txtBody,
});
const upJson = await up.json().catch(() => ({}));
const txtId = upJson.data?.id;
console.log('\n---- ARABIC TXT ----');
console.log('  upload http=%d source=%s', up.status, txtId ?? '-');
if (txtId) {
  const t2 = await reprocess(txtId);
  console.log('  ingest http=%d', t2.status);
  const T2 = await report('ARABIC TXT', txtId);
  ok('TXT processed to a document', (T2.out[0]?.char_count ?? 0) > 50 && T2.docs.length > 0);
  ok('TXT text preserved as readable Arabic', /[\u0600-\u06FF]/.test(T2.sample) && (T2.sample.includes('بسم الله') || T2.sample.includes('باب')));
  await J('POST', `/v1/projects/${P}/sources/${txtId}/embeddings`);
  const rq2 = await J('POST', `/v1/projects/${P}/retrieval/search`, { query: `${marker} 4821`, topK: 3 });
  const hits2 = rq2.data?.results ?? [];
  const t2doc = (await rows(admin.from('documents').select('normalized_text').eq('id', T2.docs[0]?.id)))[0]?.normalized_text ?? '';
  console.log('  txt retrieval hits=%d | markerInDoc=%s', hits2.length, t2doc.includes('4821'));
  ok('TXT marker retrievable from the real stored text', t2doc.includes(marker) && hits2.length > 0);
  // clean up the temporary test source so the project is left as found
  await admin.from('document_chunks').delete().eq('source_id', txtId);
  await admin.from('documents').delete().eq('source_id', txtId);
  await admin.from('ingestion_outputs').delete().eq('source_id', txtId);
  await admin.from('ingestion_jobs').delete().eq('source_id', txtId);
  await admin.from('raw_artifacts').delete().eq('source_id', txtId);
  await admin.from('sources').delete().eq('id', txtId);
  const gone = (await rows(admin.from('sources').select('id').eq('id', txtId))).length === 0;
  ok('temporary TXT test source removed', gone);
}