// K20 Skills Runtime V1 — live acceptance A–K against the real backend + Supabase.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const B = 'http://localhost:8787';
const s = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const uid = s.data.user.id;
const P = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0].id;
const SK = 'demo.context-summary';

const listSkills = async (projectId) => (await fetch(`${B}/v1/projects/${projectId}/skills`, { headers: H })).json();
const exec = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/skills/${SK}/execute`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const remember = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/memory/remember`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const runBy = async (capability, status) => {
  const r = (await admin.from('runs').select('id,status,capability_key,provider_key,model_name').eq('capability_key', capability).order('started_at', { ascending: false }).limit(30)).data ?? [];
  return r.find((x) => x.status === status);
};
const PWA = (m, ok) => console.log(m, '| PASS =', ok);

// A REGISTRY
{
  const r = (await listSkills(P)).data ?? [];
  const d = r.find((x) => x.id === SK);
  PWA('A registry has demo.context-summary v' + d?.version + ' count=' + r.length, d?.id === SK && d?.version === 1);
}
// B SIMPLE EXECUTION
{
  const r = (await exec(P, { payload: { text: 'Summarize my current preference.' } })).data;
  PWA('B execution status=' + r.status + ' issues=' + JSON.stringify(r.output?.understoodIssues), r.status === 'completed' && Array.isArray(r.output?.understoodIssues) && !!r.runId);
}
// C MEMORY DEPENDENCY
{
  const subj = 'k20c-' + Date.now();
  await remember(P, { scope: 'user', subjectId: subj, type: 'preference', key: 'preferred_language', payload: { value: 'Arabic' } });
  const r = (await exec(P, { payload: { text: 'Summarize my current preference.' }, subjectId: subj })).data;
  const lang = (r.output?.relevantContext ?? []).find((m) => m.key === 'preferred_language');
  PWA('C memory in output=' + JSON.stringify(lang), r.status === 'completed' && lang?.value === 'Arabic');
}
// D NO MODEL + E NO KNOWLEDGE (skill declares model:false, knowledge:false)
{
  const r = (await exec(P, { payload: { text: 'Summarize.' } })).data;
  const run = await runBy('k20.skills-runtime', 'completed');
  PWA('D/E completed run provider=' + run?.provider_key + ' model=' + run?.model_name + ' | no model/knowledge', r.status === 'completed' && !run?.provider_key && !run?.model_name);
}
// F AMBIGUITY GATE
{
  const r = (await exec(P, { payload: { text: 'What about that one?' } })).data;
  PWA('F ambiguity status=' + r.status + ' hasOutput=' + ('output' in r) + ' clarification=' + !!r.clarification, r.status === 'needs_clarification' && !('output' in r) && !!r.clarification);
}
// G INVALID INPUT
{
  const r = await exec(P, { payload: {} });
  PWA('G invalid input status=' + r.status + ' code=' + r.data?.error?.code, r.status === 400 && r.data?.status === 'failed' && r.data?.error?.code === 'SKILL_INVALID_INPUT');
}
// I RUN LIFECYCLE
{
  const comp = await runBy('k20.skills-runtime', 'completed');
  const fail = await runBy('k20.skills-runtime', 'failed');
  PWA('I completed-run? ' + !!comp + ' failed-run? ' + !!fail, !!comp && !!fail);
}
// J PROJECT ISOLATION (positive control)
{
  let Bp = (await admin.from('projects').select('id').eq('name', 'KIP Skills Isolation')).data[0];
  if (!Bp) Bp = (await admin.from('projects').insert({ name: 'KIP Skills Isolation' }).select('id').single()).data;
  try { await admin.from('project_memberships').insert({ project_id: Bp.id, actor_subject: uid, role: 'member' }); } catch { /* member */ }
  const subj = 'k20j-' + Date.now();
  await remember(P, { scope: 'user', subjectId: subj, type: 'preference', key: 'preferred_language', payload: { value: 'Arabic' } });
  await remember(Bp.id, { scope: 'user', subjectId: subj, type: 'preference', key: 'preferred_language', payload: { value: 'English' } });
  const rb = (await exec(Bp.id, { payload: { text: 'Summarize my current preference.' }, subjectId: subj })).data;
  const lang = (rb.output?.relevantContext ?? []).find((m) => m.key === 'preferred_language');
  PWA('J B got=' + lang?.value + ' (expect English, never Arabic)', rb.status === 'completed' && lang?.value === 'English');
}
