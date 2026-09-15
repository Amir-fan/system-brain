// K23 isolation (W/X/Y) + restart continuity (Z/AA/AB/AC).
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
const MODE = process.argv[2] ?? 'full';

if (MODE === 'full') {
  // W/X: project isolation
  let Bp = (await admin.from('projects').select('id').eq('name', 'KIP Conversation Isolation')).data[0];
  if (!Bp) Bp = (await admin.from('projects').insert({ name: 'KIP Conversation Isolation' }).select('id').single()).data;
  try { await admin.from('project_memberships').insert({ project_id: Bp.id, actor_subject: uid, role: 'member' }); } catch { /* member */ }
  const aS = d(await create(P, 'contextual'));
  const bS = d(await create(Bp.id, 'contextual'));
  // A tries to use B's session id in project A -> must 404
  const cross = await fetch(`${B}/v1/projects/${P}/conversations/${bS.id}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'x' }) });
  PWA('W project A cannot access B session (' + cross.status + ')', cross.status === 404);
  const own = await fetch(`${B}/v1/projects/${Bp.id}/conversations/${bS.id}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'x' }) });
  PWA('X positive control: B can use its own session (' + own.status + ')', own.status === 200);
  // Y: actor authorization — bad token rejected
  const noauth = await fetch(`${B}/v1/projects/${P}/conversations`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'contextual' }) });
  PWA('Y actor authorization enforced (' + noauth.status + ')', noauth.status === 401);
  // AC: no raw personal context / secrets in response
  const r = d(await say(P, aS.id, { text: 'حدث' }));
  PWA('AC no secret/raw-context leak in response', !/sk-|service_role|SUPABASE|BEGIN RSA/.test(JSON.stringify(r)));
  // AB: run persisted for the turn
  const runs = (await admin.from('runs').select('id').eq('capability_key', 'k20.skills-runtime').order('started_at', { ascending: false }).limit(5)).data ?? [];
  PWA('AB run persistence valid', runs.length > 0);
  // Prepare restart continuity via a PRIVATE session (no memory interference).
  const rs = d(await create(P, 'private'));
  const r1 = d(await say(P, rs.id, { text: 'ا', answers: [{ key: 'duration_days', value: 7 }] }));
  console.log('RESTART_CID=' + rs.id);
  PWA('Z pre-restart turn1 stores fact in session -> asks only event_date', r1.interaction?.key === 'event_date');
} else {
  // after restart: resume the SAME session by id from env
  const cid = process.env.RESTART_CID;
  const r = d(await say(P, cid, { text: '2026-02-02', answers: [{ key: 'event_date', value: '2026-02-02' }] }));
  console.log('post-restart status=' + r.status + ' readiness=' + r.readiness?.status);
  PWA('Z restart continuity: session resumed + stored fact retained (event answered -> READY)', r.status === 'completed' && r.readiness?.status === 'READY_FOR_DECISION');
  // AA: private isolation still correct after restart
  const ps = d(await create(P, 'private'));
  const pr = d(await say(P, ps.id, { text: 'حدث' }));
  PWA('AA private isolation after restart (duration still missing despite personal memory)', (pr.readiness?.missingKeys ?? []).includes('duration_days'));
}
