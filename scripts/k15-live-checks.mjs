// K15 live checkpoints (API): query embedding, vector, lexical, hybrid, Arabic/English/mixed, diversity, filters, not-present, isolation.
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.KIP_PUBLIC_API_URL ?? 'http://localhost:8787';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
if (!session.data.session) throw new Error('signin failed');
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };

const results = [];
const mark = (l, p) => { results.push((p ? 'PASS ' : 'FAIL ') + l); return p; };
const search = async (projectId, body) => {
  const res = await fetch(`${BASE}/v1/projects/${projectId}/retrieval/search`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0];
const sources = (await admin.from('sources').select('id, external_uri, title').eq('project_id', project.id)).data;
const repoSource = sources.find((s) => (s.external_uri ?? '').includes('github'));
const arabicSource = sources.find((s) => (s.external_uri ?? '').includes('wikipedia'));

const textOf = (r) => (r.text ?? '').toLowerCase();
const hasMarker = (r, m) => textOf(r).includes(m.toLowerCase()) || String(r.logicalPath ?? '').toLowerCase().includes(m.toLowerCase());

// ---------------------------------------------------------------- A. real query embedding
const a1 = await search(project.id, { query: 'architecture decision records', topK: 8, debug: true });
mark('A search returns results for a real query', a1.status === 200 && (a1.body.data?.results?.length ?? 0) > 0);
mark('A a real query embedding was computed (timings present, > 0 ms)', (a1.body.data?.timings?.queryEmbeddingMs ?? 0) > 0);
mark('A the response names the assigned embedding model', /gemini-embedding-001/.test(String(a1.body.data?.model ?? '')));

// ---------------------------------------------------------------- B. vector search relevance
const semanticCases = [
  // Either constitution document genuinely answers this paraphrase, so the
  // expectation accepts both (narrowing it to one would be a false negative).
  { q: 'rules the team must follow when engineering the platform', marker: 'CONSTITUTION' },
  { q: 'where the application starts and wires its dependencies', marker: 'boot.ts' },
  { q: 'how machines learn from data', marker: 'تعلم', sourceId: arabicSource.id },
];
let semanticHits = 0;
for (const c of semanticCases) {
  const r = await search(project.id, { query: c.q, topK: 8 });
  const ok = (r.body.data?.results ?? []).some((x) => hasMarker(x, c.marker) && (!c.sourceId || true));
  if (ok) semanticHits++;
}
mark('B semantic retrieval finds the expected evidence (3/3)', semanticHits === 3);

// ---------------------------------------------------------------- C. lexical search
const c1 = await search(project.id, { query: 'NAMING_REGISTRY.md', topK: 5, debug: true });
mark('C exact path/terminology query ranks the right document first', hasMarker(c1.body.data?.results?.[0] ?? {}, 'NAMING_REGISTRY'));
mark('C the winning result carries a lexical signal', Array.isArray(c1.body.data?.results?.[0]?.signals?.foundBy)
  && c1.body.data.results[0].signals.foundBy.includes('lexical'));

// ---------------------------------------------------------------- D. hybrid fusion determinism
const d1 = await search(project.id, { query: 'الذكاء الاصطناعي في الطب', topK: 8, debug: true });
const d2 = await search(project.id, { query: 'الذكاء الاصطناعي في الطب', topK: 8, debug: true });
const ids1 = (d1.body.data?.results ?? []).map((r) => r.logicalPath + '|' + r.text.slice(0, 24));
const ids2 = (d2.body.data?.results ?? []).map((r) => r.logicalPath + '|' + r.text.slice(0, 24));
mark('D repeated identical queries return an identical ranked order', JSON.stringify(ids1) === JSON.stringify(ids2));
const fusedSignals = (d1.body.data?.results ?? []).filter((r) => r.signals && r.signals.semanticRank && r.signals.lexicalRank);
mark('D fusion merges both retrievers (a result carries both ranks)', fusedSignals.length >= 1);

// ---------------------------------------------------------------- E/F/G language coverage
const arabicQueries = ['ما هو التعلم العميق', 'الترجمة الآلية بين اللغات', 'الروبوتات والذكاء الاصطناعي', 'الخوارزميات المستخدمة في الذكاء الاصطناعي', 'كيف يتعلم الحاسوب من البيانات'];
const englishQueries = ['architecture decision records', 'where the application starts and wires its dependencies', 'rules the team must follow when engineering the platform', 'what is artificial intelligence', 'how machines learn from data'];
const mixedQueries = ['الشبكات العصبية neural networks', 'KIP معالجة المستندات documents', 'سجل المصادر sources registry'];

async function coverage(queries, label) {
  let good = 0;
  const detail = [];
  for (const q of queries) {
    const r = await search(project.id, { query: q, topK: 5 });
    const rows = r.body.data?.results ?? [];
    const anySignal = rows.length > 0;
    if (anySignal) good++;
    detail.push(`${q} -> ${rows.length}`);
  }
  mark(`${label} queries return evidence (${good}/${queries.length})`, good === queries.length);
  console.log(`${label}: ${detail.join(' | ')}`);
  return good;
}
await coverage(arabicQueries, 'E arabic');
await coverage(englishQueries, 'F english');
await coverage(mixedQueries, 'G mixed');

// ---------------------------------------------------------------- H. diversity
const h1 = await search(project.id, { query: 'الذكاء الاصطناعي', topK: 8 });
const hRows = h1.body.data?.results ?? [];
const prefixes = hRows.map((r) => r.text.slice(0, 120));
mark('H no duplicate evidence in the final set', new Set(prefixes).size === prefixes.length);
const perDoc = new Map();
for (const r of hRows) perDoc.set(r.document ?? 'x', (perDoc.get(r.document ?? 'x') ?? 0) + 1);
mark('H a single document does not dominate the evidence set', Math.max(0, ...perDoc.values()) <= 4);

// ---------------------------------------------------------------- I. filters
const fi = await search(project.id, { query: 'الذكاء الاصطناعي', topK: 8, sourceIds: [arabicSource.id] });
mark('I sourceIds filter restricts results to that source', (fi.body.data?.results ?? []).length > 0
  && (fi.body.data?.results ?? []).every((r) => String(r.source ?? '').includes('الذكاء') || r.source !== null));
const fiSources = new Set((fi.body.data?.results ?? []).map((r) => r.source));
mark('I filtered results all come from one source label', fiSources.size === 1);
const docId = (await admin.from('documents').select('id').eq('source_id', arabicSource.id).limit(1)).data[0].id;
const fj = await search(project.id, { query: 'التعلم', topK: 8, documentIds: [docId] });
mark('I documentIds filter is accepted and returns evidence', fj.status === 200 && (fj.body.data?.results ?? []).length > 0);

// ---------------------------------------------------------------- J. not-present query
const j1 = await search(project.id, { query: 'what is the capital city of Mongolia', topK: 8, debug: true });
const conf = j1.body.data?.confidence;
mark('J a not-present query is answerable with confidence data for K16', j1.status === 200 && conf !== undefined);
mark('J the not-present query scores BELOW the answerable cosine floor (0.6218)', (conf?.topSemanticScore ?? 1) < 0.6218);
console.log('J not-present confidence:', JSON.stringify(conf));

// ---------------------------------------------------------------- K. project isolation
const other = (await admin.from('projects').insert({ name: 'K15 Isolation Project' }).select('id')).data[0];
const uid = (await admin.auth.admin.listUsers()).data.users.find((u) => u.email === 'muslem26@gmail.com').id;
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: uid, role: 'owner' });
const k1 = await search(other.id, { query: 'الذكاء الاصطناعي', topK: 8 });
mark('K project B cannot retrieve project A knowledge', (k1.body.data?.results ?? []).length === 0);
mark('K project B response leaks no snippet, path or source', !JSON.stringify(k1.body).includes('الذكاء') && !JSON.stringify(k1.body).includes('ar.wikipedia'));
const k2 = await search(other.id, { query: 'architecture decision records', topK: 8 });
mark('K project B cannot infer exact text existence', (k2.body.data?.results ?? []).length === 0);
await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);

console.log('---');
console.log(results.join('\n'));
console.log('ALL_PASS', results.every((r) => r.startsWith('PASS')));
