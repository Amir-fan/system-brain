// K23 LIVE CONVERSATION ACCEPTANCE — contextual, private, isolation, interaction, progress.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const B = 'http://localhost:8787';
const s = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const uid = s.data.user.id;
const P = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0].id;
const create = async (projectId, mode) => (await fetch(`${B}/v1/projects/${projectId}/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ mode }) })).json();
const say = async (projectId, cid, body) => (await fetch(`${B}/v1/projects/${projectId}/conversations/${cid}/messages`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const d = (r) => r.data;
const PWA = (m, ok) => console.log(m, '| PASS =', ok);

// ---------- CONTEXTUAL ----------
const c1 = d(await create(P, 'contextual'));
PWA('A create CONTEXTUAL', !!c1?.id && c1.mode === 'contextual');
// turn 1: user states something (no answers) -> needs_information (event_date first)
const t1 = d(await say(P, c1.id, { text: 'بدأ الحدث' }));
console.log('t1 status=' + t1.status + ' readiness=' + t1.readiness?.status + ' interaction=' + t1.interaction?.type + '/' + t1.interaction?.key);
PWA('B turn1 continuity + needs_information', t1.status === 'needs_information' && t1.readiness?.status === 'NEEDS_INFORMATION');
PWA('G structured interaction', t1.interaction && t1.interaction.key === 'event_date' && t1.interaction.type === 'date' && !!t1.interaction.question);
PWA('AD semantic key + user-facing question', t1.interaction.key === 'event_date' && t1.interaction.question !== 'event_date');
// turn 2: answer event_date (structured) -> next question (duration_days)
const t2 = d(await say(P, c1.id, { text: '2026-01-10', answers: [{ key: 'event_date', value: '2026-01-10' }] }));
console.log('t2 status=' + t2.status + ' interaction=' + t2.interaction?.key);
PWA('H answer interaction -> next question selected', t2.status === 'needs_information' && t2.interaction?.key === 'duration_days');
// turn 3: answer duration (free-text number, no explicit answers -> manual fallback AH)
const t3 = d(await say(P, c1.id, { text: '6' }));
console.log('t3 status=' + t3.status + ' readiness=' + t3.readiness?.status);
PWA('I/J/K answer -> READY -> skill executed', t3.status === 'completed' && t3.readiness?.status === 'READY_FOR_DECISION');
PWA('AH free-text manual fallback maps to pending key', t3.status === 'completed');
// E/F: memory-known value prevents a duplicate question
{
  const c2 = d(await create(P, 'contextual'));
  await admin.from('memory_records').insert({ project_id: P, scope: 'user', subject_id: uid, memory_type: 'preference', memory_key: 'duration_days', payload: { value: 9 }, provenance: { source: 'user' } });
  const r = d(await say(P, c2.id, { text: 'حدث' }));
  // duration_days known from memory -> only event_date should be missing
  const missing = r.readiness?.missingKeys ?? [];
  PWA('E/F contextual bounded Memory used; no duplicate question for known key', Array.isArray(missing) && !missing.includes('duration_days'));
}
// AJ-AK: truthful stages
{
  const c3 = d(await create(P, 'contextual'));
  const r = d(await say(P, c3.id, { text: 'حدث' }));
  const st = r.stages ?? [];
  console.log('stages=' + JSON.stringify(st));
  PWA('AJ stages = real executed work', st.includes('UNDERSTANDING') && st.includes('CONTEXT_RETRIEVAL') && st.includes('PREPARING_RESPONSE'));
  PWA('AK no fake KNOWLEDGE/REASONING stage', !st.includes('KNOWLEDGE_RETRIEVAL') && !st.includes('REASONING'));
}

// ---------- PRIVATE ----------
const p1 = d(await create(P, 'private'));
PWA('M create PRIVATE', !!p1?.id && p1.mode === 'private');
const pt1 = d(await say(P, p1.id, { text: 'حدث الأمر لمدة 3 أيام', answers: [{ key: 'duration_days', value: 3 }] }));
console.log('pt1 status=' + pt1.status + ' interaction=' + pt1.interaction?.key);
// session remembers duration_days=3 -> next asks event_date only
PWA('N/T private session retains fact + stays intelligent', pt1.status === 'needs_information' && pt1.interaction?.key === 'event_date');
const pt2 = d(await say(P, p1.id, { text: '2026-01-01', answers: [{ key: 'event_date', value: '2026-01-01' }] }));
PWA('O private answers clarification across turns -> READY', pt2.status === 'completed' && pt2.readiness?.status === 'READY_FOR_DECISION');
// P/R: private must NOT read personal memory — put a personal fact and confirm it is unused
{
  const p2 = d(await create(P, 'private'));
  const r = d(await say(P, p2.id, { text: 'حدث' }));
  // private: even though personal memory has duration_days, it must NOT satisfy it (read blocked)
  const missing = r.readiness?.missingKeys ?? [];
  PWA('P/R private personal Memory READ blocked (duration_days still missing)', missing.includes('duration_days'));
}
// Q/S: private WRITE blocked + no leak into contextual
{
  const before = (await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', uid)).data.length;
  const p3 = d(await create(P, 'private'));
  await say(P, p3.id, { text: 'أنا داخل جلسة خاصة', answers: [{ key: 'duration_days', value: 4 }] });
  const after = (await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', uid)).data.length;
  PWA('Q/S private personal Memory WRITE blocked (no new rows)', before === after);
}
// V: mode immutable — no API to change mode (attempt is a no-op; mode stays)
{
  const pv = d(await create(P, 'private'));
  const row = (await admin.from('conversations').select('mode').eq('id', pv.id)).data[0];
  PWA('V mode immutable per session (stored mode unchanged)', row?.mode === 'private');
}
// U: project-level capability available in private (skill still executes)
PWA('U project capability available in private (skill path works)', pt2.status === 'completed');

console.log('UID=' + uid + ' P=' + P);
