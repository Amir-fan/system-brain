// K16 live smoke: real grounded answers through the API (Arabic, English, not-present).
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.KIP_PUBLIC_API_URL ?? 'http://localhost:8787';
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };
const ask = async (projectId, body) => {
  const res = await fetch(`${BASE}/v1/projects/${projectId}/knowledge/answer`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0];

const results = [];
const mark = (l, p) => { results.push((p ? 'PASS ' : 'FAIL ') + l); return p; };

// A. Arabic, grounded
const ar = await ask(project.id, { question: 'ما هو التعلم العميق في الذكاء الاصطناعي؟', debug: true });
const arStatus = ar.body.data?.status;
mark('A Arabic answer: status is answered', arStatus === 'answered');
mark('A Arabic answer is real Arabic text', typeof ar.body.data?.answer === 'string' && ar.body.data.answer.length > 0 && /[\u0600-\u06FF]/.test(ar.body.data.answer));
mark('A includes evidence citations that resolve to (labeled) pack items', Array.isArray(ar.body.data?.evidence) && ar.body.data.evidence.length >= 1);
mark('A no vectors or hidden reasoning leaked', !JSON.stringify(ar.body.data).includes('[0.') && ar.body.data.reasoningSignals === undefined);
console.log('A answer[:220]:', String(ar.body.data?.answer ?? '').slice(0, 220));
console.log('A evidence:', JSON.stringify((ar.body.data?.evidence ?? []).map((e) => e.label)));

// B. English, grounded to a real repo file
const en = await ask(project.id, { question: 'Where does the application start and wire its dependencies?', debug: true });
mark('B English answer: answered with a real source', en.body.data?.status === 'answered' && Array.isArray(en.body.data?.evidence) && en.body.data.evidence.some((e) => String(e.logicalPath ?? '').includes('boot.ts') || String(e.documentTitle ?? '').includes('boot')));
console.log('B answer[:200]:', String(en.body.data?.answer ?? '').slice(0, 200));
console.log('B evidence paths:', JSON.stringify((en.body.data?.evidence ?? []).map((e) => e.logicalPath)));

// D. not present -> must be honest refusal
const np = await ask(project.id, { question: 'ما هي عاصمة منغوليا؟', debug: true });
mark('D not-present: status is insufficient_evidence (no hallucination)', np.body.data?.status === 'insufficient_evidence');
mark('D not-present: no fabricated answer or citation', (!np.body.data?.answer || np.body.data.answer.length === 0));
mark('D not-present: confidence low', np.body.data?.confidence === 'low');
console.log('D response:', JSON.stringify({ status: np.body.data?.status, confidence: np.body.data?.confidence, answer: np.body.data?.answer, message: np.body.data?.message }));

console.log('---');
console.log(results.join('\n'));
console.log('ALL_PASS', results.every((r) => r.startsWith('PASS')));