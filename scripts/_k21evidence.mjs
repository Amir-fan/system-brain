// K21 LIVE EVIDENCE ACCEPTANCE — structured NaqaaScanEvidenceV1 through the real Skills API.
import { createClient } from '@supabase/supabase-js';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const B = 'http://localhost:8787';
const s = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const uid = s.data.user.id;
const P = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0].id;

const evidence = {
  schemaVersion: 1, occurredAt: '2026-09-15T10:00:00Z', scannerVersion: 'naqaa.ondevice@1',
  color: { primaryColor: { value: 'dark red', status: 'observed', source: 'vision', confidence: 0.9 } },
  physical: { apparentClotting: { value: 'none_visible', status: 'inferred', source: 'vision' } },
  texture: { smoothness: { value: 'smooth', status: 'observed', source: 'vision' } },
  spatial: { stainShape: { value: 'irregular', status: 'observed', source: 'vision' } },
  quality: { rating: 'usable' },
  provenance: { scanSource: 'vision' },
};
const exec = async (projectId, body) => (await fetch(`${B}/v1/projects/${projectId}/skills/naqaa.scanner/execute`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const o = (r) => r.data?.output;
const PWA = (m, ok) => console.log(m, '| PASS =', ok);

// A registered
{ const d = (await (await fetch(`${B}/v1/projects/${P}/skills`, { headers: H })).json()).data ?? []; PWA('A naqaa.scanner registered v' + (d.find((k) => k.id === 'naqaa.scanner')?.version ?? '?'), !!d.find((k) => k.id === 'naqaa.scanner')); }

// H sufficient (evidence + cycleDay)
{
  const r = o(await exec(P, { payload: { evidence, context: { cycleDay: '4' } } }));
  const noFiqh = r && !/hayd|istihada|nifas|purity|prayer|fasting|حيض|استحاضة|نفاس/.test(JSON.stringify(r));
  const five = r?.evidence && ['color', 'physical', 'texture', 'spatial', 'quality'].every((k) => r.evidence[k]);
  console.log('H status=' + r?.status + ' suff=' + r?.sufficiency + ' qNeed=' + r?.questionNeeded);
  PWA('H completed+sufficient+no-fiqh', r?.status === 'completed' && r?.sufficiency === 'sufficient' && r?.questionNeeded === false && noFiqh);
  PWA('B five final groups', five === true);
  PWA('D apparent physical inferred (not observed)', r?.evidence?.physical?.apparentClotting?.status === 'inferred');
  PWA('L run persisted', !!r?.observability?.runId);
}

// G missing cycleDay
{ const r = o(await exec(P, { payload: { evidence } })); PWA('G needs_information+question', r?.status === 'needs_information' && r?.questionNeeded === true && r?.question?.key === 'cycle_day'); }

// I unusable quality
{ const r = o(await exec(P, { payload: { evidence: { ...evidence, quality: { rating: 'unusable', reasons: ['too dark'] } } } })); PWA('I unusable -> unusable safely', r?.status === 'unusable' && r?.sufficiency === 'unusable'); }

// F/C bounded memory (cycle_day from memory, evidence provenance untouched)
{
  const subj = 'k21ev-' + Date.now();
  await admin.from('memory_records').insert({ project_id: P, scope: 'user', subject_id: subj, memory_type: 'preference', memory_key: 'cycle_day', payload: { value: '2' }, provenance: { source: 'user' } });
  const r = o(await exec(P, { payload: { evidence }, subjectId: subj }));
  console.log('F memoryItemsUsed=' + r?.observability?.memoryItemsUsed);
  PWA('F bounded memory used (separate from evidence)', r?.observability?.memoryItemsUsed === 1 && r?.status === 'completed');
  PWA('C evidence provenance preserved (primaryColor source=vision)', r?.evidence?.color?.primaryColor?.source === 'vision');
  // N no memory pollution
  const cnt = (await admin.from('memory_records').select('id').eq('project_id', P).eq('subject_id', subj)).data.length;
  PWA('N no memory pollution (count=' + cnt + ')', cnt === 1);
}

// K project isolation (positive control)
{
  let Bp = (await admin.from('projects').select('id').eq('name', 'KIP Scanner Isolation')).data[0];
  if (!Bp) Bp = (await admin.from('projects').insert({ name: 'KIP Scanner Isolation' }).select('id').single()).data;
  try { await admin.from('project_memberships').insert({ project_id: Bp.id, actor_subject: uid, role: 'member' }); } catch { /* member */ }
  const subj = 'k21k-' + Date.now();
  await admin.from('memory_records').insert({ project_id: Bp.id, scope: 'user', subject_id: subj, memory_type: 'preference', memory_key: 'cycle_day', payload: { value: '9' }, provenance: { source: 'user' } });
  const r = o(await exec(Bp.id, { payload: { evidence }, subjectId: subj }));
  console.log('K B status=' + r?.status + ' memUsed=' + r?.observability?.memoryItemsUsed);
  PWA('K B uses its own bounded memory, no A leakage (completed via B cycle_day=9)', r?.status === 'completed' && r?.observability?.memoryItemsUsed === 1);
}
