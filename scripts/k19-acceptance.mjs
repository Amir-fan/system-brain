// K19 Understanding Foundation V1 — live acceptance A–J against the real backend + Supabase.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const B = 'http://localhost:8787';
const s = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const uid = s.data.user.id;
const P = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0].id;

const evaluate = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/understanding/evaluate`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const remember = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/memory/remember`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const supersede = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/memory/supersede`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const recall = async (projectId, q) => (await fetch(`${B}/v1/projects/${projectId}/memory/recall?` + new URLSearchParams(q), { headers: H })).json();
const history = async (projectId, q) => (await fetch(`${B}/v1/projects/${projectId}/memory/history?` + new URLSearchParams(q), { headers: H })).json();

const PWA = (m, ok) => console.log(m, '| PASS =', ok);

// A SIMPLE QUESTION
{
  const r = (await evaluate(P, { text: 'What time is my appointment?' })).data;
  PWA('A question -> act=' + r.dialogueAct + ' status=' + r.status + ' issues=' + r.issues.length, r.dialogueAct === 'QUESTION' && r.status === 'CLEAR' && r.issues.length === 1);
}
// B MULTI-ISSUE
{
  const r = (await evaluate(P, { text: 'What time is my appointment, and what documents do I need?' })).data;
  PWA('B multi-issue count=' + r.issues.length, r.issues.length === 2);
}
// C CORRECTION + MEMORY (then explicit supersede) — fresh subject for a clean run.
{
  const subj = 'k19c-' + Date.now();
  await remember(P, { scope: 'user', subjectId: subj, type: 'preference', key: 'preferred_time', payload: { value: '09:00' } });
  const r = (await evaluate(P, { text: 'No, I meant 10:00.', subjectId: subj })).data;
  const c = r.corrections?.[0];
  PWA('C correction act=' + r.dialogueAct + ' ' + (c ? c.target + ' ' + c.old + '->' + c.new : 'none'), r.dialogueAct === 'CORRECTION' && c?.target === 'preferred_time' && c.old === '09:00' && c.new === '10:00');
  await supersede(P, { scope: 'user', subjectId: subj, type: 'preference', key: 'preferred_time', payload: { value: '10:00' } });
  const active = (await recall(P, { scope: 'user', subjectId: subj, key: 'preferred_time' })).data;
  const hist = (await history(P, { scope: 'user', subjectId: subj, key: 'preferred_time' })).data;
  const st = Object.fromEntries(hist.map((m) => [(m.payload ?? {}).value, m.status]));
  PWA('C supersede active=' + ((active[0]?.payload ?? {}).value) + ' statuses=' + JSON.stringify(st), (active[0]?.payload ?? {}).value === '10:00' && st['09:00'] === 'superseded' && st['10:00'] === 'active');
}
// D CONFIRMATION
{
  const r = (await evaluate(P, { text: 'Yes, that is what I meant.' })).data;
  PWA('D confirmation act=' + r.dialogueAct + ' status=' + r.status, r.dialogueAct === 'CONFIRMATION' && r.status === 'CLEAR');
}
// E REJECTION unknown alternative
{
  const r = (await evaluate(P, { text: 'No, not that one.' })).data;
  PWA('E rejection act=' + r.dialogueAct + ' status=' + r.status, r.dialogueAct === 'REJECTION' && r.status === 'NEEDS_CLARIFICATION');
}
// F RESOLVABLE REFERENCE (single conversation memory)
{
  await remember(P, { scope: 'conversation', subjectId: 'conv-k19', type: 'state', key: 'appointment', payload: { value: '10:00 meeting' } });
  const r = (await evaluate(P, { text: 'What about that one?', conversationId: 'conv-k19' })).data;
  PWA('F reference resolved=' + r.references.resolved + ' status=' + r.status, r.references.resolved === true && r.status === 'CLEAR');
}
// G UNRESOLVABLE MATERIAL REFERENCE
{
  const r = (await evaluate(P, { text: 'What about that one?' })).data;
  PWA('G reference resolved=' + r.references.resolved + ' status=' + r.status + ' referent=' + r.references.referent, r.references.resolved === false && r.status === 'NEEDS_CLARIFICATION' && r.references.referent === undefined);
}
// H TEMPORAL
{
  const r = (await evaluate(P, { text: 'My appointment is tomorrow at 10.', requestTimestamp: '2026-09-15T10:00:00Z' })).data;
  const date = r.facts.find((f) => f.key === 'date'); const time = r.facts.find((f) => f.key === 'time');
  PWA('H date=' + date?.value + '(' + date?.original + ') time=' + time?.value, date?.value === '2026-09-16' && date?.original === 'tomorrow' && time?.value === '10:00');
}
// I BOUNDED MEMORY
{
  for (let i = 0; i < 12; i++) await remember(P, { scope: 'user', subjectId: uid, type: 'preference', key: 'extra_' + i, payload: { value: 'v' + i } });
  const r = (await evaluate(P, { text: 'What time is my appointment?', subjectId: uid })).data;
  PWA('I user context count=' + r.contextUsed.userCount + ' (<=5)', r.contextUsed.userCount >= 0 && r.contextUsed.userCount <= 5);
}
// J PROJECT ISOLATION (B positive control; A memory never used by B)
{
  let Bp = (await admin.from('projects').select('id').eq('name', 'KIP Understanding Isolation')).data[0];
  if (!Bp) Bp = (await admin.from('projects').insert({ name: 'KIP Understanding Isolation' }).select('id').single()).data;
  try { await admin.from('project_memberships').insert({ project_id: Bp.id, actor_subject: uid, role: 'member' }); } catch { /* member */ }
  // B has its OWN preference memory; A has preferred_time=10:00 active.
  await remember(Bp.id, { scope: 'user', subjectId: uid, type: 'preference', key: 'b_theme', payload: { value: 'blue' } });
  const rb = (await evaluate(Bp.id, { text: 'No, I meant 11:00.', subjectId: uid })).data;
  const cB = rb.corrections?.[0];
  // B's correction must target B's OWN preference (b_theme), never A's preferred_time —
  // this proves A's memory was not injected into B's Understanding context.
  PWA('J B correction target=' + cB?.target + ' (expect b_theme, not preferred_time) | B count=' + rb.contextUsed.userCount, cB?.target === 'b_theme' && cB?.target !== 'preferred_time');
}
