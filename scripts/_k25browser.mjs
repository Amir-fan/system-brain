// K25 slice 1 — /tests browser E2E on the REAL frontend + backend: the admin picks the
// source-grounded fiqh skill, talks to the REAL runtime, answers a structured question,
// continues the session, and inspects the bounded structured trace.
// Usage: node scripts/_k25browser.mjs <contextual|private> [screenshotPath]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9950 + Math.floor(Math.random() * 60);
const PROFILE = mkdtempSync(join(tmpdir(), 'k25ui-'));
const BASE = 'http://127.0.0.1:5173';
const PROJECT = '7e73c7a3-4973-4a6f-849b-ec84988a3d14';
const EMAIL = process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local';
const PASSWORD = process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123';
const SKILL = 'naqaa.fiqh-hayd';
const APPROVED = '44bff587';
const CASE = 'نزل علي سائل شفاف في اليوم الاخير من دورتي مع لمعة حمراء خفيفة جدا .. هل هو حيض ؟';
const SECTION = process.argv[2] ?? 'contextual';
const SHOT = process.argv[3] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (n, ok, extra = '') => { results.push([n, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${extra ? ' | ' + extra : ''}`); };

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', '--window-size=1440,1200', '--no-first-run', `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let ws; let id = 0; const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => { const m = ++id; pending.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })); setTimeout(() => pending.has(m) && (pending.delete(m), rej(new Error('t/o ' + method))), 30000); });
const evalJs = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
async function waitFor(expr, ms = 120000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(expr)) return true; } catch {} await sleep(500); } return false; }
const setInput = (sel, v) => evalJs(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NOELEM';
  const p = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(p,'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
const setSelect = (sel, v) => evalJs(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NOELEM';
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('change',{bubbles:true})); return el.value; })()`);
const clickText = (t) => evalJs(`(() => { for (const el of document.querySelectorAll('button,a,[role="button"]')) if ((el.textContent||'').trim() === ${JSON.stringify(t)}) { el.click(); return true; } return false; })()`);
const COMPOSER = 'input[placeholder*="اكتب رسالتك"]';

const SNAP = `(() => {
  const card = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('rounded-xl2') && d.querySelector('div.rounded-2xl'));
  const bubbles = card ? [...card.querySelectorAll('div.rounded-2xl')].map(b => (b.innerText||'').trim()) : [];
  const labelFor = (el) => { let n = el; for (let i=0;i<5 && n;i++){ n = n.parentElement; if (!n) break; const p = n.querySelector('p'); if (p && (p.innerText||'').trim()) return p.innerText.trim(); } return ''; };
  const inputs = card ? [...card.querySelectorAll('input')].filter(i => !(i.placeholder||'').includes('اكتب رسالتك')).map(i => ({ ph: i.placeholder, type: i.type, label: labelFor(i) })) : [];
  const buttons = card ? [...card.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(Boolean) : [];
  const qEls = card ? [...card.querySelectorAll('p')].filter(p => String(p.className||'').includes('text-xs') && (p.innerText||'').trim().length > 3) : [];
  const question = qEls.length ? qEls[qEls.length - 1].innerText.trim() : '';
  return { cardText: card ? (card.innerText||'').replace(/\\s+/g,' ') : '', bubbles, inputs, buttons, question,
           stages: card ? [...card.querySelectorAll('span.rounded-full')].map(s => (s.innerText||'').trim()) : [] };
})()`;

const answerCurrent = async () => {
  const s = await evalJs(SNAP);
  for (const b of s.buttons) {
    if (b === 'نعم' || b === 'لا') { await clickText(b); return b; }
  }
  const optBtn = s.buttons.find((b) => !['إرسال', 'محادثة جديدة', 'خاص', 'سياقي', 'إنهاء وإغلاق', 'ترقية'].includes(b));
  if (optBtn) { await clickText(optBtn); return optBtn; }
  const input = s.inputs[0];
  if (input) { await setInput(`input[placeholder="${input.ph}"]`, input.type === 'date' ? '2026-09-16' : '٧ أيام'); await clickText('إرسال'); return 'typed'; }
  return null;
};

(async () => {
  try {
    let target;
    for (let i = 0; i < 80 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(300); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
    await cdp('Page.enable'); await cdp('Runtime.enable');

    await cdp('Page.navigate', { url: BASE + '/tests' });
    await sleep(3000);
    if (await evalJs(`!!document.querySelector('input[type=email]')`)) {
      await setInput('input[type=email]', EMAIL);
      await setInput('input[type=password]', PASSWORD);
      await evalJs(`document.querySelector('form').requestSubmit()`);
    }
    await waitFor(`!document.querySelector('input[type=email]')`, 30000);
    await evalJs(`localStorage.setItem('kip.activeProjectId', '${PROJECT}')`);
    await cdp('Page.navigate', { url: BASE + '/tests' });
    await sleep(3000);
    const ready = await waitFor(`document.body.innerText.includes('محادثة جديدة')`, 30000);
    rec('A /tests loads inside the real admin shell', ready);

    // ---- skill selection (the console drives a chosen registered skill) ----
    const skillSelExpr = `(() => { const sels=[...document.querySelectorAll('select')];
      const i = sels.findIndex(s => [...s.options].some(o => o.value === ${JSON.stringify(SKILL)}));
      return i < 0 ? -1 : i; })()`;
    await waitFor(`(${skillSelExpr}) >= 0`, 25000); // the skills list is fetched async
    const skillSel = await evalJs(skillSelExpr);
    rec('B skill selector is present (skills list from the real registry)', skillSel >= 0, `index=${skillSel}`);
    if (skillSel >= 0) {
      await evalJs(`(() => { const s = document.querySelectorAll('select')[${skillSel}];
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, ${JSON.stringify(SKILL)});
        s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()`);
      await sleep(400);
      const chosen = await evalJs(`document.querySelectorAll('select')[${skillSel}].value`);
      rec('C naqaa.fiqh-hayd is selected in the console', chosen === SKILL, String(chosen));
    }
    await clickText(SECTION === 'private' ? 'خاص' : 'سياقي');
    await sleep(400);
    await clickText('محادثة جديدة');
    await waitFor(`!!document.querySelector('${COMPOSER}')`, 30000);

    // ---- TURN 1: the real case ----
    await setInput(COMPOSER, CASE);
    await evalJs(`document.querySelector('${COMPOSER}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    console.log('  waiting for the real runtime (model + retrieval)…');
    const gotQ = await waitFor(`(() => { const s = ${SNAP}; return (s.buttons.length > 0 || s.inputs.length > 0) && !!s.question; })()`, 180000);
    await sleep(1000);
    const s1 = await evalJs(SNAP);
    console.log('  T1 card =', s1.cardText.slice(0, 220));
    rec(`${SECTION}: T1 a real structured question is rendered`, gotQ, JSON.stringify(s1.inputs));
    rec(`${SECTION}: T1 no empty assistant bubble`, s1.bubbles.filter((b) => !b).length === 0, JSON.stringify(s1.bubbles));
    rec(`${SECTION}: T1 control is NOT a naked 'أدخل قيمة'`, !(s1.inputs.length > 0 && s1.inputs.every((i) => (i.label || '').length === 0)), JSON.stringify(s1.inputs));
    rec(`${SECTION}: T1 progress chips are real stages`, s1.stages.length >= 3, JSON.stringify(s1.stages));
    const q1 = s1.question || (s1.inputs[0]?.label ?? '');
    rec(`${SECTION}: T1 the question is human Arabic (not a runtime key)`, q1.length > 8 && !q1.includes('_'), q1.slice(0, 80));

    await evalJs(`window.__q1 = ${JSON.stringify(q1)}`);

    // ---- TURN 2: answer through the rendered control ----
    const ans = await answerCurrent();
    console.log('  answered with:', ans);
    const gotQ2 = await waitFor(`(() => { const s = ${SNAP};
      return !!s.question && s.question !== window.__q1; })()`, 180000);
    await sleep(1000);
    const s2 = await evalJs(SNAP);
    console.log('  T2 card =', s2.cardText.slice(0, 220));
    const q2 = s2.question || (s2.inputs[0]?.label ?? '');
    rec(`${SECTION}: T2 answering the control continues the session`, gotQ2 && !!ans, `answer=${ans}`);
    rec(`${SECTION}: T2 the next question is different (dynamic, not a loop)`, !!q2 && q2 !== q1, `q2=${q2.slice(0, 70)}`);
    rec(`${SECTION}: T2 no empty assistant bubble`, s2.bubbles.filter((b) => !b).length === 0, JSON.stringify(s2.bubbles));

    // ---- TRACE DRAWER ----
    await clickText('عرض تفاصيل الاختبار');
    const drawer = await waitFor(`document.body.innerText.includes('المسألة والمصادر')`, 15000);
    await sleep(700);
    const drawerText = await evalJs(`(() => { const d = [...document.querySelectorAll('div')].find(x => (x.innerText||'').includes('المسألة والمصادر') && (x.innerText||'').includes('المراحل الفعلية')); return d ? (d.innerText||'').replace(/\\s+/g,' ') : ''; })()`);
    console.log('  drawer =', String(drawerText).slice(0, 420));
    rec(`${SECTION}: trace drawer opens with the skill section`, drawer);
    rec(`${SECTION}: trace shows the REAL issue text`, /المسألة/.test(drawerText) && String(drawerText).length > 60);
    rec(`${SECTION}: trace shows the approved source id (no invented source)`, String(drawerText).includes(APPROVED));
    rec(`${SECTION}: trace shows derived requirement keys`, /متطلبات مشتقة/.test(drawerText));
    rec(`${SECTION}: trace shows cited passages`, /مقاطع مستشهد بها/.test(drawerText));
    rec(`${SECTION}: trace exposes NO prompts / chain-of-thought`, !/أنت محلل|system prompt|chain|reasoning:|أنت مساعد/.test(String(drawerText)));

    if (SHOT) { const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); writeFileSync(SHOT, Buffer.from(shot.data, 'base64')); console.log('  screenshot =', SHOT); }
    const fails = results.filter(([, c]) => !c);
    console.log(`\nSECTION ${SECTION}: PASS ${results.length - fails.length}/${results.length}`);
    process.exit(fails.length ? 1 : 0);
  } catch (e) { console.error('E2E ERROR:', e.message); process.exit(1); }
})();
