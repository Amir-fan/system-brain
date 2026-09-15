// K18 live acceptance A–G against the real Supabase project + real backend.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const B = 'http://localhost:8787';
const s = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const uid = s.data.user.id;
const P = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0].id;

const remember = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/memory/remember`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const supersede = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/memory/supersede`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const recall = async (projectId, q) => (await fetch(`${B}/v1/projects/${projectId}/memory/recall?` + new URLSearchParams(q), { headers: H })).json();
const history = async (projectId, q) => (await fetch(`${B}/v1/projects/${projectId}/memory/history?` + new URLSearchParams(q), { headers: H })).json();
const archive = async (projectId, id) => (await fetch(`${B}/v1/projects/${projectId}/memory/archive`, { method: 'POST', headers: H, body: JSON.stringify({ id }) })).json();
const retrieve = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/memory/retrieve`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const val = (r) => (r?.payload ?? {}).value;

// A. USER
await remember(P, { scope: 'user', subjectId: uid, type: 'preference', key: 'preferred_language', payload: { value: 'Arabic' }, provenance: { source: 'user' } });
const ua = (await recall(P, { scope: 'user', subjectId: uid, key: 'preferred_language' })).data;
console.log('A USER recall =', val(ua?.[0]), '| PASS =', val(ua?.[0]) === 'Arabic');

// B. CONVERSATION
await remember(P, { scope: 'conversation', subjectId: 'conv-1', type: 'preference', key: 'output_style', payload: { value: 'concise' }, provenance: { source: 'conversation' } });
const cb = (await recall(P, { scope: 'conversation', subjectId: 'conv-1', key: 'output_style' })).data;
console.log('B CONVERSATION recall =', val(cb?.[0]), '| PASS =', val(cb?.[0]) === 'concise');

// C. CASE
await remember(P, { scope: 'case', subjectId: 'case-1', type: 'state', key: 'case_status', payload: { value: 'waiting_for_documents' }, provenance: { source: 'application' } });
const cc = (await recall(P, { scope: 'case', subjectId: 'case-1', key: 'case_status' })).data;
console.log('C CASE recall =', val(cc?.[0]), '| PASS =', val(cc?.[0]) === 'waiting_for_documents');

// D. SUPERSESSION 09:00 -> 10:00 -> 11:00
await remember(P, { scope: 'user', subjectId: uid, type: 'preference', key: 'preferred_time', payload: { value: '09:00' } });
await supersede(P, { scope: 'user', subjectId: uid, type: 'preference', key: 'preferred_time', payload: { value: '10:00' } });
await supersede(P, { scope: 'user', subjectId: uid, type: 'preference', key: 'preferred_time', payload: { value: '11:00' } });
const active = (await recall(P, { scope: 'user', subjectId: uid, key: 'preferred_time' })).data;
const hist = (await history(P, { scope: 'user', subjectId: uid, key: 'preferred_time' })).data;
const statusMap = Object.fromEntries(hist.map((r) => [val(r), r.status]));
const dPass = active.length === 1 && val(active[0]) === '11:00' && statusMap['09:00'] === 'superseded' && statusMap['10:00'] === 'superseded' && statusMap['11:00'] === 'active';
console.log('D SUPERSESSION active=', val(active[0]), '| statuses=', JSON.stringify(statusMap), '| PASS =', dPass);

// E. ARCHIVE
const arch = (await remember(P, { scope: 'case', subjectId: 'case-arch', type: 'fact', key: 'doc', payload: { value: 'to-be-archived' } })).data;
const archRes = (await archive(P, arch.id)).data;
const eActive = (await recall(P, { scope: 'case', subjectId: 'case-arch' })).data;
console.log('E ARCHIVE archived-status =', archRes?.status, '| active-after =', eActive.length, '| PASS =', archRes?.status === 'archived' && eActive.length === 0);

// F. RELEVANCE — multiple memories, bounded + active relevant
await remember(P, { scope: 'case', subjectId: 'case-rel', type: 'state', key: 'status', payload: { value: 'open' } });
await remember(P, { scope: 'case', subjectId: 'case-rel', type: 'preference', key: 'language', payload: { value: 'Arabic' } });
const frel = (await retrieve(P, { scope: 'case', subjectId: 'case-rel', limit: 1 })).data;
const fKeys = frel.map((r) => r.memoryKey);
console.log('F RELEVANT bounded=', frel.length, '| keys=', JSON.stringify(fKeys), '| PASS =', frel.length === 1);

// G. ISOLATION — Project B cannot touch A's memory (with a positive control).
let Bp = (await admin.from('projects').select('id').eq('name', 'KIP Memory Isolation')).data[0];
if (!Bp) {
  Bp = (await admin.from('projects').insert({ name: 'KIP Memory Isolation' }).select('id').single()).data;
}
try { await admin.from('project_memberships').insert({ project_id: Bp.id, actor_subject: uid, role: 'member' }); } catch { /* already a member */ }
// Positive control: B can use its own memory.
await remember(Bp.id, { scope: 'user', subjectId: uid, type: 'preference', key: 'only_b', payload: { value: 'b-only' } });
const gB = (await recall(Bp.id, { scope: 'user', subjectId: uid })).data;
// A's memory must NOT be reachable from B, and B cannot archive A's record.
const gHasA = (gB ?? []).some((r) => r.memoryKey === 'preferred_time');
const aTimeId = (await history(P, { scope: 'user', subjectId: uid, key: 'preferred_time' })).data[0].id;
const gArc = (await archive(Bp.id, aTimeId)).data;
const gAactive = (await recall(P, { scope: 'user', subjectId: uid, key: 'preferred_time' })).data;
console.log('G ISOLATION B sees own keys=', JSON.stringify((gB ?? []).map((r) => r.memoryKey)), '| B saw A preferred_time?', gHasA, '| B archive A ->', gArc === null || gArc === undefined, '| A still active len=', gAactive?.length, '| PASS =', !gHasA && (gArc === null || gArc === undefined) && gAactive?.length === 1);
