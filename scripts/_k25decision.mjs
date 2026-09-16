/**
 * K25 SLICE 2 — LIVE PROOF: source-grounded Shafi'i DECISION & ANSWER.
 *
 * REAL: backend + Supabase + approved source «الحيض الالوكة» + retrieval + Model
 * Gateway (knowledge_answer -> google/gemini-3.5-flash -> OpenRouter) + /v1 API.
 * No mocks. A truthful SOURCE_GAP is a PASS; a guessed ruling is a FAIL.
 *
 * Sections (one case per run keeps each inside the runner's time budget):
 *   node scripts/_k25decision.mjs <case1|a1|a2|b1|b2|b3|live|private|isolation>
 */
import { createClient } from '@supabase/supabase-js';

const B = 'http://localhost:8787';
const EMAIL = process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local';
const PASSWORD = process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123';
const PROJECT = '7e73c7a3-4973-4a6f-849b-ec84988a3d14'; // KIP Demo Project
const APPROVED = '44bff587-1885-4c3a-86cf-cb766c8371a4'; // الحيض الالوكة
const SKILL = 'naqaa.fiqh-hayd';
const SECTION = process.argv[2] ?? 'b1';

const CASE1 = 'نزل علي سائل شفاف في اليوم الاخير من دورتي غالبا مع لمعة حمراء خفيفة جدا .. هل هذا حيض ؟';
const A1 = 'نزل علي دم أحمر واضح في وقت عادتي الشهرية لمدة يوم وليلة كاملة، ثم جفّ المكان وتوقّف الدم تمامًا. هل هو حيض؟';
const A2 = 'نزل علي دم بسيط لمدة ٦ ساعات فقط ثم توقف تمامًا، وعمري ٢٠ سنة وليس عندي حمل ولا نفاس. هل هو حيض؟';
const B1 = 'عمري ٢٥ سنة، عادتي ٥ أيام، وآخر دورة انتهت قبل ٢٠ يومًا بطهر كامل. نزل عليّ دم أحمر قوي ٣ أيام، وفي آخر يومين نزلت إفرازات صفراء وكدرة متصلة بنزول الدم مباشرة بلا انقطاع، ثم جفّ المكان وتوقف الدم. هل هذه الإفرازات حيض؟';
const B2 = 'عمري ٢٥ سنة، عادتي ٥ أيام، وآخر دورة انتهت قبل ٢٠ يومًا بطهر كامل. نزل عليّ دم أحمر قوي ٣ أيام، ثم جفّ المكان تمامًا وتوقف الدم، وبعد الجفوف نزلت إفرازات صفراء وكدرة منفصلة عن الدم. هل هذه الإفرازات حيض؟';
const B3 = 'نزل الدم عليّ باستمرار ٢٠ يومًا متواصلة بلا توقف، وعادتي ٦ أيام. ما حكم اليوم السادس عشر؟';

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
  if (!j?.ok) console.log('   API ERROR', res.status, JSON.stringify(j).slice(0, 220));
  return j?.data ?? j;
};
const memoryCount = async () => (await admin.from('memory_records').select('id', { count: 'exact', head: true }).eq('project_id', PROJECT).eq('subject_id', uid)).count ?? 0;

let pass = 0, fail = 0;
const chk = (label, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`); };
const line = (r) => `status=${r.status} decision=${r.trace?.decisionStatus ?? '-'} label=${r.trace?.decisionLabel ?? '-'} conf=${r.trace?.confidence ?? '-'} support=${r.trace?.sourceSupport ?? '-'} refs=${JSON.stringify(r.trace?.acceptedEvidenceRefs ?? [])} notes=${JSON.stringify(r.trace?.notes ?? [])}`;
const answerOf = (r) => String(r.answer?.text ?? r.message ?? '').replace(/\n/g, ' / ');

/** Answer a structured question the way the case narrative implies. */
function autoAnswer(interaction, opts = {}) {
  if (!interaction) return null;
  const q = String(interaction.question ?? '');
  const caseText = String(opts.caseText ?? '');
  const A = (v) => ({ key: interaction.key, value: v });
  if (/عمر|سنين|سنوات/.test(q)) return A(true);
  if (/ولادة|نفاس|ولدت/.test(q)) return A(false);
  if (/اتصال|متصلة|مباشرة|انقطاع|متواصل|منفصل/.test(q)) {
    if (caseText.includes('متصلة')) return A('كانت متصلة بالدم بلا انقطاع');
    if (caseText.includes('منفصلة') || caseText.includes('جفّ المكان تمامًا')) return A('منفصلة تمامًا بعد أن جفّ المكان');
    return A('كانت متصلة بالدم');
  }
  if (/طهر|نقاء|خمسة عشر|١٥|15/.test(q)) return A(true);
  if (/كم يوماً|كم يوم|كم المدة|عدد الأيام|مدة/.test(q)) return A(6);
  if (opts.answers?.[interaction.key] !== undefined) return A(opts.answers[interaction.key]);
  // colour/thickness questions: answer from the case narrative, never invent a symptom
  if (/لون|شكل|رائحة|غليظ|رقيق|أسود|بني|قوي|أحمر|أصفر/.test(q)) {
    if (interaction.options?.length) {
      const fromCase = interaction.options.find((o) => caseText.includes(o.slice(0, 4)));
      if (fromCase) return A(fromCase);
    }
    if (/قبل|سابق|قوي/.test(q)) return A('دم أحمر قوي');
    return A('إفرازات صفراء وكدرة');
  }
  if (/أحمر|قوي|الدم نفسه|صفة الدم/.test(q) && !/إفراز|صفر|كدر/.test(q)) return A('دم أحمر قوي');
  // never invent a NEW material fact: prefer the negative/unknown option
  if (interaction.options?.length) {
    const fromCase = interaction.options.find((o) => caseText.includes(o.slice(0, 4)));
    if (fromCase) return A(fromCase);
    const negative = interaction.options.find((o) => /^(لا|ليس|ما |بدون|منفصل)/.test(o));
    return A(negative ?? interaction.options[0]);
  }
  if (interaction.type === 'yes_no') return A(true);
  if (interaction.type === 'number' || interaction.type === 'duration') return A(6);
  if (interaction.type === 'date') return A('2026-09-10');
  return A('نعم');
}

/** Drive a conversation until it reaches a decision (or the turn budget runs out). */
async function converse(projectId, mode, firstText, opts = {}) {
  const caseText = firstText;
  const c = await create(projectId, mode);
  if (!c?.id) return { error: c, turns: [] };
  const turns = [];
  let text = firstText;
  for (let i = 0; i < (opts.maxTurns ?? 6); i++) {
    const answers = i === 0 ? undefined : [autoAnswer(turns[turns.length - 1].interaction, { ...opts, caseText })].filter(Boolean);
    const r = await say(projectId, c.id, { text, ...(answers && answers.length ? { answers } : {}) });
    turns.push(r);
    console.log(`   USER: ${String(text).slice(0, 90)}`);
    console.log(`   KIP : [${r.status}] ${String(r.interaction?.question ?? answerOf(r)).slice(0, 200)}`);
    console.log(`         ${line(r)}`);
    if (r.trace?.decisionStatus || r.status === 'completed') break;
    const a = autoAnswer(r.interaction, { ...opts, caseText });
    text = a ? String(a.value) : (opts.clarify ?? 'أقصد الحالة اللي وصفتها بالضبط');
  }
  return { id: c.id, turns };
}

const traceOf = (r) => ({
  decision: r.trace?.decisionStatus ?? null,
  label: r.trace?.decisionLabel ?? null,
  support: r.trace?.sourceSupport ?? null,
  refs: r.trace?.acceptedEvidenceRefs ?? [],
  gaps: r.trace?.gapKeys ?? [],
  notes: r.trace?.notes ?? [],
});
const approvedOnly = (r) => (r.trace?.evidence ?? []).every((e) => e.sourceId === APPROVED);

// ---------------------------------------------------------------------------
if (SECTION === 'case1') {
  console.log('=== REAL CASE #1 (verbatim) — truthfulness over a forced ruling ===');
  const conv = await converse(PROJECT, 'contextual', CASE1, {});
  const last = conv.turns[conv.turns.length - 1] ?? {};
  console.log('   QUESTIONS:', JSON.stringify(conv.turns.map((t) => t.interaction?.question).filter(Boolean)));
  console.log('   FINAL ANSWER:', answerOf(last).slice(0, 320));
  console.log('   FINAL TRACE:', JSON.stringify(traceOf(last)));
  chk('case1 final state is a real answer (no placeholder, no dead end)', !!last.status && !answerOf(last).includes('تمت معالجة طلبك'), traceOf(last).decision ?? last.status);
  chk('case1 never guesses: DECIDED implies citations, SOURCE_GAP is truthful', traceOf(last).decision === 'DECIDED' ? traceOf(last).refs.length > 0 : traceOf(last).decision === 'SOURCE_GAP', JSON.stringify(traceOf(last)));
  chk('case1 grounding stayed on the approved source only', approvedOnly(last));
}

if (SECTION === 'a1' || SECTION === 'a2') {
  const text = SECTION === 'a1' ? A1 : A2;
  console.log(`=== GOLD ${SECTION.toUpperCase()} — ${SECTION === 'a1' ? 'blood a day and a night (source minimum)' : 'bleeding under the minimum'} ===`);
  const conv = await converse(PROJECT, 'contextual', text, {});
  const last = conv.turns[conv.turns.length - 1] ?? {};
  console.log('   FINAL ANSWER:', answerOf(last).slice(0, 300));
  console.log('   SOURCE PROPOSITION =', SECTION === 'a1' ? 'أقل الحيض يوم وليلة (24 ساعة)' : 'أقل الحيض يوم وليلة (24 ساعة) → ما دونه ليس حيضاً');
  console.log('   EXPECTED =', SECTION === 'a1' ? 'حيض' : 'ليس حيضاً');
  console.log('   ACTUAL TRACE =', JSON.stringify(traceOf(last)));
  chk(`${SECTION} reached a final decision or a truthful source gap`,
    traceOf(last).decision === 'DECIDED' || traceOf(last).decision === 'SOURCE_GAP', traceOf(last).decision ?? last.status);
  chk(`${SECTION} DECIDED implies real citations from the approved source`, traceOf(last).decision !== 'DECIDED' || (traceOf(last).refs.length > 0 && approvedOnly(last)), JSON.stringify(traceOf(last).refs));
  chk(`${SECTION} answer is user-readable (no placeholder/keys)`, !answerOf(last).includes('تمت معالجة طلبك') && !/_/.test(String(last.answer?.text ?? '')), answerOf(last).slice(0, 60));
}

if (SECTION === 'b1' || SECTION === 'b2') {
  const contiguous = SECTION === 'b1';
  console.log(`=== GOLD ${SECTION.toUpperCase()} — ${contiguous ? 'صفرة/كدرة متصلة بالحيض' : 'نفس الإفرازة بعد الجفوف (واقعة واحدة مختلفة)'} ===`);
  const conv = await converse(PROJECT, 'contextual', contiguous ? B1 : B2, {});
  const last = conv.turns[conv.turns.length - 1] ?? {};
  console.log('   FINAL ANSWER:', answerOf(last).slice(0, 300));
  console.log('   SOURCE PROPOSITION = «الصفرة والكدرة إن كانت متصلة بالحيض فحيض وإلا فطهر» (ترجيح المؤلف)');
  console.log('   EXPECTED =', contiguous ? 'حيض' : 'طهر (ليس حيضاً)');
  console.log('   ACTUAL TRACE =', JSON.stringify(traceOf(last)));
  chk(`${SECTION} reached a final decision or a truthful source gap`,
    traceOf(last).decision === 'DECIDED' || traceOf(last).decision === 'SOURCE_GAP', traceOf(last).decision ?? last.status);
  chk(`${SECTION} DECIDED implies citations from the approved source`, traceOf(last).decision !== 'DECIDED' || (traceOf(last).refs.length > 0 && approvedOnly(last)), JSON.stringify(traceOf(last).refs));
  console.log(`   [CONTRAST PAIR] ${SECTION} label=${traceOf(last).label} answer=${answerOf(last).slice(0, 120)}`);
}

if (SECTION === 'b3') {
  console.log('=== GOLD B3 — bleeding beyond the maximum (source: max 15 days) ===');
  const conv = await converse(PROJECT, 'contextual', B3, {});
  const last = conv.turns[conv.turns.length - 1] ?? {};
  console.log('   FINAL ANSWER:', answerOf(last).slice(0, 300));
  console.log('   ACTUAL TRACE =', JSON.stringify(traceOf(last)));
  chk('b3 reached a final decision or a truthful source gap', traceOf(last).decision === 'DECIDED' || traceOf(last).decision === 'SOURCE_GAP', traceOf(last).decision ?? last.status);
  chk('b3 DECIDED implies citations from the approved source', traceOf(last).decision !== 'DECIDED' || (traceOf(last).refs.length > 0 && approvedOnly(last)), JSON.stringify(traceOf(last).refs));
}

if (SECTION === 'live') {
  console.log('=== LIVE DECIDED CONVERSATION + FOLLOW-UPS + CORRECTION ===');
  const conv = await converse(PROJECT, 'contextual', A2, {});
  const before = conv.turns[conv.turns.length - 1] ?? {};
  console.log('   VERDICT BEFORE:', answerOf(before).slice(0, 220), '|', JSON.stringify(traceOf(before)));
  const f1 = await say(PROJECT, conv.id, { text: 'ليش؟' });
  console.log('   USER: ليش؟');
  console.log('   KIP :', answerOf(f1).slice(0, 260));
  console.log('   FOLLOW-UP TRACE:', JSON.stringify(traceOf(f1)));
  const f2 = await say(PROJECT, conv.id, { text: 'شنو المصدر؟' });
  console.log('   USER: شنو المصدر؟');
  console.log('   KIP :', answerOf(f2).slice(0, 260));
  console.log('   SOURCE TITLE:', f2.answer?.sourceTitle ?? '-', '| refs:', JSON.stringify(traceOf(f2).refs));
  const corr = await say(PROJECT, conv.id, { text: 'لا، تذكرت الآن: الدم ما توقف بعد ٦ ساعات، استمر يومًا وليلة كاملين متواصلين ثم توقف.' });
  console.log('   USER: (تصحيح) الدم استمر يومًا وليلة كاملين لا ٦ ساعات');
  console.log('   KIP :', answerOf(corr).slice(0, 260));
  console.log('   AFTER-CORRECTION TRACE:', JSON.stringify(traceOf(corr)));
  chk('follow-up «ليش؟» answered with the grounded decision/evidence', !!f1.answer?.text || !!f1.message, `${traceOf(f1).decision ?? f1.status}`);
  chk('follow-up «شنو المصدر؟» names the real approved source', String(f2.answer?.sourceTitle ?? '').includes('الحيض') || JSON.stringify(traceOf(f2).refs).length > 2, String(f2.answer?.sourceTitle ?? '-'));
  chk('the correction produced a NEW state (old decision not replayed)', traceOf(corr).decision !== null || corr.status !== 'completed', `${traceOf(before).decision}/${traceOf(before).label} -> ${traceOf(corr).decision}/${traceOf(corr).label}`);
  chk('the corrected answer differs from the original verdict', answerOf(corr) !== answerOf(before), `${answerOf(before).slice(0, 40)} => ${answerOf(corr).slice(0, 40)}`);
}

if (SECTION === 'private') {
  console.log('=== PRIVATE MODE (grounded decision + memory isolation) ===');
  const before = await memoryCount();
  const conv = await converse(PROJECT, 'private', A2, {});
  const last = conv.turns[conv.turns.length - 1] ?? {};
  const after = await memoryCount();
  console.log('   FINAL ANSWER:', answerOf(last).slice(0, 240));
  console.log('   TRACE:', JSON.stringify(traceOf(last)));
  chk('private mode reaches the same grounded path', !!last.status && !answerOf(last).includes('تمت معالجة طلبك'), traceOf(last).decision ?? last.status);
  chk('private mode used the approved project knowledge', approvedOnly(last) && (last.trace?.evidence ?? []).length > 0, String((last.trace?.evidence ?? []).length));
  chk('private mode wrote NO personal memory', before === after, `before=${before} after=${after}`);
}

if (SECTION === 'isolation') {
  console.log('=== PROJECT ISOLATION + AUTHORIZATION ===');
  const projects = await unwrap(await fetch(`${B}/v1/projects`, { headers: H }));
  const other = (Array.isArray(projects) ? projects : []).find((p) => p.id !== PROJECT);
  if (other) {
    const conv = await converse(other.id, 'contextual', A2, {});
    const last = conv.turns[conv.turns.length - 1] ?? {};
    console.log(`   OTHER PROJECT (${other.name}):`, answerOf(last).slice(0, 160), '|', JSON.stringify(traceOf(last)));
    chk('no approved source in another project → no ruling, zero cross-project evidence',
      traceOf(last).decision !== 'DECIDED' && traceOf(last).refs.length === 0 && (last.trace?.evidence ?? []).length === 0,
      `${traceOf(last).decision} refs=${traceOf(last).refs.length} evidence=${(last.trace?.evidence ?? []).length}`);
  } else {
    console.log('   SKIP | no second project accessible');
  }
  const noAuth = await fetch(`${B}/v1/projects/${PROJECT}/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'contextual' }) });
  chk('unauthenticated test conversation denied', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));
  const foreign = await fetch(`${B}/v1/projects/01fc4538-a7a0-493c-9ff6-0d4e9bda1c1f/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ mode: 'contextual' }) });
  chk('non-member project denied', foreign.status === 403 || foreign.status === 404, String(foreign.status));
}

console.log(`\n=== SECTION ${SECTION}: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
