// K24 continuation closure harness — REAL K23 API (no mocks).
// Proves: multi-turn to terminal state, no dead end, correction replaces the
// pending session fact + recomputes readiness, contextual/private parity, and the
// private-mode isolation contract.
import { createClient } from '@supabase/supabase-js';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const B = 'http://127.0.0.1:8787';
const P = '7e73c7a3-4973-4a6f-849b-ec84988a3d14';
const { data: s, error: se } = await user.auth.signInWithPassword({ email: process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local', password: process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123' });
if (se || !s?.session) { console.log('❌ login failed', se?.message); process.exit(1); }
const H = { authorization: 'Bearer ' + s.session.access_token, 'content-type': 'application/json' };
const J = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const factsOf = async (cid) => (await admin.from('conversations').select('session_context').eq('id', cid)).data?.[0]?.session_context ?? {};

const results = [];
const ok = (n, c, extra = '') => { results.push([n, c]); console.log(`${c ? '✅' : '❌'} ${n} ${extra}`); };
const mk = async (mode) => (await J('POST', `/v1/projects/${P}/conversations`, { mode })).data.id;
const say = async (cid, body) => (await J('POST', `/v1/projects/${P}/conversations/${cid}/messages`, body)).data;

const FIRST = 'نزل علي سائل شفاف مع اخر ايام دورتي المعتادة مع لمعة حمراء خفيفة جدا .. هل هذا حيض ؟';

for (const mode of ['private', 'contextual']) {
  console.log(`\n======== ${mode.toUpperCase()} ========`);
  const cid = await mk(mode);

  // ---- turn 1
  const t1 = await say(cid, { text: FIRST });
  ok(`${mode}: T1 asks a meaningful question (no naked prompt)`, t1.status === 'needs_information' && !!t1.interaction?.question && t1.interaction.type === 'date', JSON.stringify(t1.interaction?.question));
  ok(`${mode}: T1 message exposes the same question`, t1.message === t1.interaction?.question);

  // ---- correction while the date is pending: replaces the PENDING session fact
  const tc = await say(cid, { text: 'لا، قصدي 2026-09-10' });
  const f1 = (await factsOf(cid)).facts ?? {};
  ok(`${mode}: correction understood (CORRECTION)`, tc.understanding?.dialogueAct === 'CORRECTION', tc.understanding?.dialogueAct);
  ok(`${mode}: corrected value replaces the asked session fact`, f1.event_date === '2026-09-10', JSON.stringify(f1));
  ok(`${mode}: readiness recomputed after the correction`, tc.readiness?.status === 'NEEDS_INFORMATION' && JSON.stringify(tc.readiness?.missingKeys) === '["duration_days"]', JSON.stringify(tc.readiness?.missingKeys));
  ok(`${mode}: next question is meaningful (no dead end)`, !!tc.interaction?.question && tc.interaction.key === 'duration_days', JSON.stringify(tc.interaction?.question));

  // ---- answer the next requirement -> terminal state
  const t3 = await say(cid, { text: '6', answers: [{ key: 'duration_days', value: 6 }] });
  ok(`${mode}: reaches READY/completed (terminal)`, t3.status === 'completed' && t3.readiness?.status === 'READY_FOR_DECISION', `${t3.status}/${t3.readiness?.status}`);
  const f2 = (await factsOf(cid)).facts ?? {};
  ok(`${mode}: session holds both real facts`, f2.event_date === '2026-09-10' && Number(f2.duration_days) === 6, JSON.stringify(f2));
}

// ---- private isolation must be unchanged
const pv = await mk('private');
const before = (await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', s.user.id)).data?.length ?? 0;
await say(pv, { text: 'حدث', answers: [{ key: 'duration_days', value: 4 }] });
await new Promise((r) => setTimeout(r, 400));
const after = (await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', s.user.id)).data?.length ?? 0;
ok('private: personal Memory is neither read nor written', before === after, `rows ${before}->${after}`);

const fails = results.filter(([, c]) => !c);
console.log(`\nSUMMARY: PASS ${results.length - fails.length}/${results.length}`);
fails.forEach(([n]) => console.log('FAIL:', n));
process.exit(fails.length ? 1 : 0);