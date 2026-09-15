// K22 LIVE READINESS ACCEPTANCE — generic Decision Readiness gate through the real API.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const B = 'http://localhost:8787';
const s = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const uid = s.data.user.id;
const P = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0].id;
const SK = 'demo.decision-readiness';
const exec = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/skills/${SK}/execute`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const d = (r) => r.data;
const PWA = (m, ok) => console.log(m, '| PASS =', ok);

// A/B/F: clear input but insufficient -> needs_information + one simple question
{
  const r = d(await exec(P, { payload: {} }));
  const q = r?.readiness?.nextQuestion?.wording ?? '';
  console.log('A status=' + r?.status + ' readiness=' + r?.readiness?.status + ' next=' + r?.readiness?.nextQuestion?.key);
  PWA('A/B needs_information + exact missing + question', r?.status === 'needs_information' && r?.readiness?.status === 'NEEDS_INFORMATION' && r?.readiness?.missing?.[0]?.key === 'prior_complete_days' && !!q);
  PWA('E/F wording separate + simple/non-jurisprudential', q && q !== r?.readiness?.missing?.[0]?.description && !/hayd|istihada|nifas|purity|طهارة|حيض|استحاضة|نفاس|يجوز|حرام/.test(q));
  PWA('J(block) body did NOT run', r?.output === undefined);
}

// G/K: supply the answer -> READY + downstream body runs
{
  const r = d(await exec(P, { payload: { context: { prior_complete_days: 6 } } }));
  console.log('G status=' + r?.status + ' readiness=' + r?.readiness?.status + ' output=' + JSON.stringify(r?.output));
  PWA('G/K READY + downstream allowed', r?.status === 'completed' && r?.readiness?.status === 'READY_FOR_DECISION' && r?.output?.decisionAllowed === true);
}

// C/M: bounded real Memory satisfies the requirement (no duplicate question)
{
  const subj = 'k22c-' + Date.now();
  await admin.from('memory_records').insert({ project_id: P, scope: 'user', subject_id: subj, memory_type: 'preference', memory_key: 'prior_complete_days', payload: { value: 4 }, provenance: { source: 'user' } });
  const before = (await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', subj)).data.length;
  const r = d(await exec(P, { payload: {}, subjectId: subj }));
  const after = (await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', subj)).data.length;
  console.log('C status=' + r?.status + ' readiness=' + r?.readiness?.status);
  PWA('C/M bounded memory satisfies -> READY (no question)', r?.status === 'completed' && r?.readiness?.status === 'READY_FOR_DECISION');
  PWA('N no memory pollution', before === after);
}

// L: project isolation positive control
{
  let Bp = (await admin.from('projects').select('id').eq('name', 'KIP Readiness Isolation')).data[0];
  if (!Bp) Bp = (await admin.from('projects').insert({ name: 'KIP Readiness Isolation' }).select('id').single()).data;
  try { await admin.from('project_memberships').insert({ project_id: Bp.id, actor_subject: uid, role: 'member' }); } catch { /* member */ }
  const subj = 'k22l-' + Date.now();
  await admin.from('memory_records').insert({ project_id: P, scope: 'user', subject_id: subj, memory_type: 'preference', memory_key: 'prior_complete_days', payload: { value: 9 }, provenance: { source: 'user' } });
  // B has NO such memory -> must still need information (never uses A's value)
  const r = d(await exec(Bp.id, { payload: {}, subjectId: subj }));
  console.log('L B status=' + r?.status + ' readiness=' + r?.readiness?.status);
  PWA('L isolation: B does NOT see A memory (still needs_information)', r?.status === 'needs_information' && r?.readiness?.status === 'NEEDS_INFORMATION');
}

// O/P: no fiqh fields; no model call
{
  const r = d(await exec(P, { payload: { context: { prior_complete_days: 2 } } }));
  PWA('O no fiqh fields', !/hayd|istihada|nifas|purity|prayer|fasting|حيض|استحاضة|نفاس/.test(JSON.stringify(r)));
  PWA('L run persisted (runId)', !!r?.runId);
}
