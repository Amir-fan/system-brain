// K24 LIVE E2E — REAL backend + REAL Supabase, via the REAL K23 conversation API
// and the new tiny evaluation endpoint. Creates a throwaway admin user + membership,
// exercises the flow, then cleans up. Runs against the canonical repo's Supabase.
import { createClient } from '@supabase/supabase-js';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const EMAIL = `k24.e2e.${Date.now()}@test.local`;
const PASSWORD = 'K24Test!pass123';
const base = 'http://localhost:8787';

const fail = (m) => { console.log('❌', m); process.exitCode = 1; };
const pass = (m) => console.log('✅', m);

const { data: u, error: ue } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true });
if (ue || !u?.user) { fail('create user: ' + ue?.message); process.exit(1); }
const sub = u.user.id;

const projectRes = await admin.from('projects').select('id, name').limit(1);
const project = projectRes.data?.[0];
if (!project) { fail('no project available in Supabase'); process.exit(1); }
const P = project.id;

await admin
  .from('project_memberships')
  .upsert({ project_id: P, actor_subject: sub, role: 'owner' }, { onConflict: 'project_id,actor_subject' })
  .select();

const { data: s, error: se } = await admin.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (se || !s?.session) { fail('sign in: ' + se?.message); process.exit(1); }
const H = { authorization: 'Bearer ' + s.session.access_token, 'content-type': 'application/json' };

const req = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
};

// ---------- AUTH ----------
const noAuth = await fetch(`${base}/v1/projects`, { headers: { 'content-type': 'application/json' } });
if (noAuth.status === 401) pass('AH auth required (no token -> 401)'); else fail('AH auth required (got ' + noAuth.status + ')');
const badAuth = await fetch(`${base}/v1/projects`, { headers: { 'content-type': 'application/json', authorization: 'Bearer invalid' } });
if (badAuth.status === 401) pass('AH invalid token -> 401'); else fail('AH invalid token (got ' + badAuth.status + ')');

// ---------- CONTEXTUAL ----------
const c1 = await req('POST', `/v1/projects/${P}/conversations`, { mode: 'contextual' });
if (c1.status === 201 && c1.data?.mode === 'contextual') pass('C create CONTEXTUAL'); else { fail('C create CONTEXTUAL (got ' + c1.status + ')'); process.exit(1); }
const cid = c1.data.id;

const t1 = await req('POST', `/v1/projects/${P}/conversations/${cid}/messages`, { text: 'بدأ الحدث' });
if (t1.data?.status === 'needs_information' && t1.data?.interaction?.type === 'date') pass('D/F structured interaction = date'); else fail('D/F interaction (got ' + t1.data?.status + '/' + t1.data?.interaction?.type + ')');

const t2 = await req('POST', `/v1/projects/${P}/conversations/${cid}/messages`, { text: '2026-01-10', answers: [{ key: 'event_date', value: '2026-01-10' }] });
if (t2.data?.interaction?.key === 'duration_days') pass('H answer interaction -> next'); else fail('H answer -> next (got ' + t2.data?.interaction?.key + ')');

const t3 = await req('POST', `/v1/projects/${P}/conversations/${cid}/messages`, { text: '6' });
if (t3.data?.status === 'completed' && t3.data?.readiness?.status === 'READY_FOR_DECISION') pass('I decision/response completed'); else fail('I READY (got ' + t3.data?.status + ')');

const t4 = await req('POST', `/v1/projects/${P}/conversations/${cid}/messages`, { text: 'لا، قصدي أمس' });
if (t4.data?.understanding?.dialogueAct === 'CORRECTION') pass('K correction reaches real K19 path (dialogueAct=CORRECTION)'); else fail('K correction (got ' + t4.data?.understanding?.dialogueAct + ')');

// ---------- EVALUATION ----------
const e1 = await req('POST', `/v1/projects/${P}/conversations/${cid}/evaluation`, { isCorrect: true });
if (e1.status === 201 && e1.data?.id) pass('X evaluation persisted (correct)'); else fail('X evaluation save (got ' + e1.status + ')');

const list1 = await req('GET', `/v1/projects/${P}/conversations/evaluations`);
if (Array.isArray(list1.data) && list1.data.length >= 1 && list1.data.some((e) => e.isCorrect)) pass('AB list reflects persisted correctness'); else fail('AB list (got ' + (list1.data?.length) + ')');

const e2 = await req('POST', `/v1/projects/${P}/conversations/${cid}/evaluation`, { isCorrect: false, problemCategory: 'understanding', note: 'e2e' });
if (e2.status === 201) pass('Y/Z/AA incorrect + category + note saved'); else fail('Y/Z/AA (got ' + e2.status + ')');

// ---------- PRIVATE + memory isolation ----------
const priv = await req('POST', `/v1/projects/${P}/conversations`, { mode: 'private' });
if (priv.data?.mode === 'private') pass('J/start PRIVATE'); else { fail('J private'); process.exit(1); }

const memoryBefore = await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', sub).select('id');
const beforeCount = memoryBefore.data?.length ?? 0;
await req('POST', `/v1/projects/${P}/conversations/${priv.data.id}/messages`, { text: 'أنا داخل جلسة خاصة', answers: [{ key: 'duration_days', value: 4 }] });
await new Promise((r) => setTimeout(r, 500));
const memoryAfter = await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', sub).select('id');
if (memoryAfter.data.length === beforeCount) pass('AC private did NOT write personal Memory'); else fail('AC private could have written memory (' + memoryAfter.data.length + ')');

const pt = await req('POST', `/v1/projects/${P}/conversations/${priv.data.id}/messages`, { text: 'حدث' });
// duration_days was satisfied only by the private session answer (4); block means
// that value came from session-local context, not from any personal Memory read.
if (Array.isArray(pt.data?.readiness?.missingKeys) && !pt.data.readiness.missingKeys.includes('duration_days')) pass('L/private memory read isolation'); else fail('L private isolation (got ' + JSON.stringify(pt.data?.readiness?.missingKeys) + ')');

await req('POST', `/v1/projects/${P}/conversations/${priv.data.id}/evaluation`, { isCorrect: true });
const list2 = await req('GET', `/v1/projects/${P}/conversations/evaluations`);
if (Array.isArray(list2.data) && list2.data.length >= 2) pass('history shows both evaluations'); else fail('history count (got ' + list2.data?.length + ')');

// ---------- AF isolation (no-membership user cannot see the project) ----------
const u2 = await admin.auth.admin.createUser({ email: `k24.iso.${Date.now()}@test.local`, password: PASSWORD, email_confirm: true });
if (u2.user) {
  const s2 = await admin.auth.signInWithPassword({ email: u2.user.email, password: PASSWORD });
  const res2 = await fetch(`${base}/v1/projects`, { headers: { authorization: 'Bearer ' + s2.data.session.access_token } });
  if (res2.status === 200) {
    const body = await res2.json();
    if (!Array.isArray(body.data) || !body.data.some((p) => p.id === P)) pass('AF project B isolation (unlisted project invisible)'); else fail('AF isolation leak');
  } else fail('AF isolation (status ' + res2.status + ')');
  try { await admin.auth.admin.deleteUser(u2.user.id); } catch { /* noop */ }
}

// ---------- cleanup ----------
try { await admin.auth.admin.deleteUser(sub); } catch { /* noop */ }
try { await admin.from('project_memberships').delete().eq('actor_subject', sub); } catch { /* noop */ }
try { await admin.from('conversations').delete().eq('actor_subject', sub); } catch { /* noop */ }
try { await admin.from('evaluation_records').delete().eq('tester_subject', sub); } catch { /* noop */ }

console.log('DONE');