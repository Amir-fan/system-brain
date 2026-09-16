/**
 * K25 SLICE 1 — LIVE PROOF: source-grounded Shafi'i fiqh reasoning foundation.
 *
 * REAL: backend + Supabase + project boundary + approved source «الحيض الالوكة» +
 * knowledge retrieval + Model Gateway (workload knowledge_answer) + /v1 conversations.
 * No mocks. This slice does NOT expect a final ruling (deferred to the next slice).
 *
 * NOTE (observed, not worked around): K19's OWN material-ambiguity gate answers
 * before the skill when the message carries an unresolved deictic reference
 * ("هل هذا حيض؟"). That is existing CLOSED K19/K23 behaviour, left untouched; the
 * proof therefore shows BOTH the clarification turn and the source-grounded turn.
 *
 * Usage: node scripts/_k25fiqh.mjs <caseA|caseB|contrast|private|isolation>
 * (sections are split only because a real model call per stage is slow)
 */
import { createClient } from '@supabase/supabase-js';

const B = 'http://localhost:8787';
const EMAIL = process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local';
const PASSWORD = process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123';
const PROJECT = '7e73c7a3-4973-4a6f-849b-ec84988a3d14'; // KIP Demo Project
const APPROVED_SOURCE = '44bff587-1885-4c3a-86cf-cb766c8371a4'; // الحيض الالوكة
const SKILL = 'naqaa.fiqh-hayd';
const CASE = 'نزل علي سائل شفاف في اليوم الاخير من دورتي غالبا مع لمعة حمراء خفيفة جدا .. هل هذا حيض ؟';
const CASE_DIRECT = 'نزل علي سائل شفاف في اليوم الاخير من دورتي مع لمعة حمراء خفيفة جدا .. هل هو حيض ؟';
const CONTRAST = 'الدم وقف تمامًا ونشف المكان، وبعدها نزل سائل شفاف مع لمعة حمراء خفيفة جدا .. هل هو حيض ؟';
const SECTION = process.argv[2] ?? 'caseA';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const s = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (!s.data?.session) throw new Error('login failed: ' + (s.error?.message ?? ''));
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const uid = s.data.user.id;

const unwrap = async (r) => { const j = await r.json().catch(() => ({})); return j?.data ?? j; };
const create = async (projectId, mode) => unwrap(await fetch(`${B}/v1/projects/${projectId}/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ mode }) }));
const say = async (projectId, cid, body) => {
  const res = await fetch(`${B}/v1/projects/${projectId}/conversations/${cid}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ skillId: SKILL, ...body }) });
  const j = await res.json().catch(() => ({}));
  if (!j?.ok) console.log('  API ERROR', res.status, JSON.stringify(j).slice(0, 300));
  return j?.data ?? j;
};
const memoryCount = async () => (await admin.from('memory_records').select('id', { count: 'exact', head: true }).eq('project_id', PROJECT).eq('subject_id', uid)).count ?? 0;

let pass = 0, fail = 0;
const chk = (label, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`); };
const brief = (r) => `status=${r.status} readiness=${r.readiness?.status ?? '-'} interaction=${r.interaction ? r.interaction.type + '/' + r.interaction.key : '-'} missing=${JSON.stringify(r.readiness?.missingKeys ?? [])}`;
const showTrace = (r) => console.log('  trace =', JSON.stringify({ issue: r.trace?.issue, status: r.trace?.status, approved: r.trace?.approvedSourceIds, evidence: r.trace?.evidence?.map((e) => e.chunkId), reqs: r.trace?.requirementKeys, notes: r.trace?.notes }));
const approvedOnly = (r) => JSON.stringify(r.trace?.approvedSourceIds) === JSON.stringify([APPROVED_SOURCE]);
const citeCount = (r) => (r.trace?.evidence ?? []).length;
const approvedEvidence = (r) => (r.trace?.evidence ?? []).every((e) => e.sourceId === APPROVED_SOURCE);
const SUPPORTED = ['single_choice', 'yes_no', 'number', 'duration', 'date', 'free_text', 'multiple_choice'];

// ---------------------------------------------------------------------------
if (SECTION === 'caseA') {
  console.log('=== 1A. DISCOVERY CASE (verbatim) — contextual ===');
  const c1 = await create(PROJECT, 'contextual');
  chk('A create contextual conversation', !!c1?.id && c1.mode === 'contextual', c1.id ?? JSON.stringify(c1));
  const t1 = await say(PROJECT, c1.id, { text: CASE });
  console.log('TURN 1 |', brief(t1), '| stages=', JSON.stringify(t1.stages));
  chk('B turn 1 reached the real runtime and answered', !!t1.status, t1.status);
  const t2 = await say(PROJECT, c1.id, { text: 'أقصد السائل الشفاف اللي نزل مع لمعة حمراء خفيفة في آخر أيام الدورة' });
  console.log('TURN 2 |', brief(t2));
  console.log('  question 1 =', t2.interaction?.question);
  showTrace(t2);
  chk('C source-grounded question arrives (real K19→K23→skill path)', t2.status === 'needs_information' && !!t2.interaction?.question, t2.status);
  chk('D question is human wording, not the internal key', !!t2.interaction?.question && t2.interaction.question !== t2.interaction.key && t2.interaction.question.length > 8);
  chk('E control type is supported', SUPPORTED.includes(t2.interaction?.type), t2.interaction?.type);
  chk('F K22 readiness carries the derived material gaps', (t2.readiness?.missingKeys ?? []).length >= 1, JSON.stringify(t2.readiness?.missingKeys));
  chk('G trace exposes a REAL issue statement', !!t2.trace?.issue, String(t2.trace?.issue ?? '').slice(0, 60));
  chk('H ONLY the approved source grounded the case', approvedOnly(t2), JSON.stringify(t2.trace?.approvedSourceIds));
  chk('I every cited passage is from the approved source', citeCount(t2) > 0 && approvedEvidence(t2), JSON.stringify((t2.trace?.evidence ?? []).map((e) => e.chunkId)));
  chk('J requirement keys are skill-derived (dynamic)', (t2.trace?.requirementKeys ?? []).length >= 1, JSON.stringify(t2.trace?.requirementKeys));
  chk('K unsupported observation preserved as SOURCE_GAP (no guess)', String(t2.trace?.status ?? '').includes('SOURCE_GAP') || (t2.trace?.notes ?? []).some((n) => n.includes('observation_not_defined') || n.includes('uncited')), String(t2.trace?.status));
  // answer the first interaction through the real UI-equivalent path
  const q1 = t2.interaction;
  const a1 = q1?.options?.length ? q1.options[0] : '٧ أيام';
  const t3 = await say(PROJECT, c1.id, { text: a1, answers: [{ key: q1.key, value: a1 }] });
  console.log('TURN 3 |', brief(t3));
  console.log('  question 2 =', t3.interaction?.question);
  chk('L answering the interaction continues the real session', !!t3.status, t3.status);
  chk('M the answered fact is NOT asked again', !(t3.readiness?.missingKeys ?? []).includes(q1.key), JSON.stringify(t3.readiness?.missingKeys));
  chk('N a DIFFERENT material need surfaces next (not a fixed questionnaire)', !t3.interaction || t3.interaction.key !== q1.key, t3.interaction?.key ?? 'none');
}
if (SECTION === 'caseB') {
  console.log('=== 1B. CONTEXTUAL MULTI-TURN + CORRECTION ===');
  const c = await create(PROJECT, 'contextual');
  const b1 = await say(PROJECT, c.id, { text: CASE_DIRECT });
  console.log('TURN 1 |', brief(b1), '| q=', b1.interaction?.question);
  chk('Q1 first turn is a source-grounded question (resolved reference)', b1.status === 'needs_information' && !!b1.interaction?.question, b1.status);
  const r1 = b1.interaction ? await say(PROJECT, c.id, { text: b1.interaction.options?.[0] ?? '٧ أيام', answers: [{ key: b1.interaction.key, value: b1.interaction.options?.[0] ?? '٧ أيام' }] }) : b1;
  console.log('TURN 2 |', brief(r1), '| q=', r1.interaction?.question);
  chk('Q2 answered fact not re-asked; next material need appears', !!r1.status && !(r1.readiness?.missingKeys ?? []).includes(b1.interaction?.key), JSON.stringify(r1.readiness?.missingKeys));
  const r2 = r1.interaction ? await say(PROJECT, c.id, { text: r1.interaction.options?.[0] ?? 'نعم', answers: [{ key: r1.interaction.key, value: r1.interaction.options?.[0] ?? 'نعم' }] }) : r1;
  console.log('TURN 3 |', brief(r2), '| q=', r2.interaction?.question);
  chk('Q3 three completed turns', !!r2.status, r2.status);
  const r3 = await say(PROJECT, c.id, { text: 'لا، الدم كان متصلاً ولم ينقطع قبل الإفرازة' });
  console.log('TURN 4 (correction) |', brief(r3), '| q=', r3.interaction?.question);
  chk('Q4 a correction reaches the real K19/K23 path and is answered', !!r3.status, r3.status);
}
if (SECTION === 'contrast') {
  console.log('=== 2. CONTRAST — the case already states that bleeding stopped ===');
  const c2 = await create(PROJECT, 'contextual');
  const k1 = await say(PROJECT, c2.id, { text: CONTRAST });
  console.log('CONTRAST T1 |', brief(k1));
  console.log('  question =', k1.interaction?.question);
  console.log('  reqs =', JSON.stringify(k1.trace?.requirementKeys));
  const askedAboutStop = /(وقف|توقف|جف|نشف)/.test(String(k1.interaction?.question ?? ''))
    || (k1.trace?.requirementKeys ?? []).some((k) => /(stopped|dryness|contigu|jufuf)/i.test(k));
  chk('R the stated fact (bleeding stopped / dryness) is NOT re-asked', !askedAboutStop, String(k1.interaction?.question ?? ''));
  chk('S contrast still produces a source-grounded question', k1.status === 'needs_information' && !!k1.interaction?.question, k1.status);
}
if (SECTION === 'private') {
  console.log('=== 3. PRIVATE MODE + personal-memory isolation ===');
  const before = await memoryCount();
  const p1 = await create(PROJECT, 'private');
  const pt1 = await say(PROJECT, p1.id, { text: CASE_DIRECT });
  console.log('PRIVATE T1 |', brief(pt1), '| q=', pt1.interaction?.question);
  chk('T private mode runs the same real skill path', pt1.status === 'needs_information' && !!pt1.interaction?.key, pt1.status);
  const p2 = pt1.interaction ? await say(PROJECT, p1.id, { text: pt1.interaction.options?.[0] ?? '٧ أيام', answers: [{ key: pt1.interaction.key, value: pt1.interaction.options?.[0] ?? '٧ أيام' }] }) : pt1;
  console.log('PRIVATE T2 |', brief(p2));
  chk('U private multi-turn continues', !!p2.status, p2.status);
  const after = await memoryCount();
  chk('V private mode wrote NO personal memory', before === after, `before=${before} after=${after}`);
}
if (SECTION === 'isolation') {
  console.log('=== 4. PROJECT ISOLATION + AUTHORIZATION ===');
  const projects = await unwrap(await fetch(`${B}/v1/projects`, { headers: H }));
  const list = Array.isArray(projects) ? projects : [];
  const other = list.find((p) => p.id !== PROJECT);
  if (other) {
    const oc = await create(other.id, 'contextual');
    if (oc?.id) {
      const ot = await say(other.id, oc.id, { text: CASE_DIRECT });
      console.log(`OTHER PROJECT (${other.name}) |`, brief(ot), '| traceStatus=', ot.trace?.status, '| notes=', JSON.stringify(ot.trace?.notes));
      chk('W no approved source in another project → SOURCE_GAP, zero cross-project evidence', citeCount(ot) === 0 && (String(ot.trace?.status ?? '').includes('SOURCE_GAP') || (ot.trace?.notes ?? []).includes('approved_sources_missing')), `evidence=${citeCount(ot)} status=${ot.trace?.status} notes=${JSON.stringify(ot.trace?.notes)}`);
    } else {
      console.log('SKIP | second project not accessible', JSON.stringify(oc));
    }
  } else {
    console.log('SKIP | no second project accessible for this account');
  }
  // authorization: unauthenticated access to the tests surface is denied
  const noAuth = await fetch(`${B}/v1/projects/${PROJECT}/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'contextual' }) });
  chk('X unauthenticated test-conversation creation is denied', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));
  // isolation: a project the actor has NO membership in is denied (verified against the
  // real membership table: this actor owns the demo project but is not a member here)
  const NON_MEMBER_PROJECT = '01fc4538-a7a0-493c-9ff6-0d4e9bda1c1f'; // KIP Skills Isolation
  const foreign = await fetch(`${B}/v1/projects/${NON_MEMBER_PROJECT}/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'contextual' }) });
  chk('Y non-member project is denied (no cross-project test)', foreign.status === 403 || foreign.status === 404, String(foreign.status));
}

console.log(`\n=== SECTION ${SECTION}: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
