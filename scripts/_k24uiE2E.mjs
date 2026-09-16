// K24 /tests browser E2E — REAL frontend + backend. Proves the multi-turn flow
// never dead-ends, every structured control carries its question, and both modes
// reach the terminal state.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9850 + Math.floor(Math.random() * 120);
const PROFILE = mkdtempSync(join(tmpdir(), 'k24ui-'));
const BASE = 'http://127.0.0.1:5173';
const PROJECT = '7e73c7a3-4973-4a6f-849b-ec84988a3d14';
const EMAIL = process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local';
const PASSWORD = process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123';
const SHOT = process.argv[2] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (n, ok, extra = '') => { results.push([n, ok]); console.log(`${ok ? '✅' : '❌'} ${n} ${extra}`); };

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', '--window-size=1440,1100', '--no-first-run', `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let ws; let id = 0; const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => { const m = ++id; pending.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })); setTimeout(() => pending.has(m) && (pending.delete(m), rej(new Error('t/o ' + method))), 25000); });
const evalJs = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
async function waitFor(expr, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(expr)) return true; } catch {} await sleep(300); } return false; }
const setInput = (sel, v) => evalJs(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NOELEM';
  const p = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(p,'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
const clickText = (t) => evalJs(`(() => { for (const el of document.querySelectorAll('button,a,[role="button"]')) if ((el.textContent||'').trim() === ${JSON.stringify(t)}) { el.click(); return true; } return false; })()`);

// DOM introspection of the live conversation card
const CARD = `[...document.querySelectorAll('div')].find(d => String(d.className||'').includes('rounded-xl2') && d.querySelector('div.rounded-2xl'))`;
const SNAPSHOT = `(() => {
  const card = ${CARD};
  if (!card) return { error: 'card not found' };
  const bubbles = [...card.querySelectorAll('div.rounded-2xl')].map(b => (b.innerText||'').trim());
  const labelFor = (el) => { let n = el; for (let i=0;i<4 && n;i++){ n = n.parentElement; if (!n) break; const p = n.querySelector('p'); if (p && (p.innerText||'').trim()) return p.innerText.trim(); } return ''; };
  const controls = [...card.querySelectorAll('input')].filter(i => !(i.placeholder||'').includes('اكتب رسالتك')).map(i => ({ ph: i.placeholder, type: i.type, label: labelFor(i) }));
  const footer = document.querySelector('input[placeholder*="اكتب رسالتك"]');
  return { bubbles, controls, cardText: (card.innerText||'').replace(/\\s+/g,' '),
           footerUsable: !!footer && !footer.disabled,
           stages: [...card.querySelectorAll('span.rounded-full')].map(s => (s.innerText||'').trim()) }; })()`;

async function runMode(mode) {
  console.log(`\n======== ${mode.toUpperCase()} ========`);
  await cdp('Page.navigate', { url: BASE + '/tests' });
  await sleep(3000);
  await waitFor(`document.body.innerText.includes('محادثة جديدة')`, 20000);
  await clickText(mode === 'private' ? 'خاص' : 'سياقي');
  await sleep(300);
  await clickText('محادثة جديدة');
  await waitFor(`!!document.querySelector('input[placeholder*="اكتب رسالتك"]')`, 15000);

  // ---- TURN 1
  await setInput('input[placeholder*="اكتب رسالتك"]', 'نزل علي سائل شفاف مع اخر ايام دورتي المعتادة مع لمعة حمراء خفيفة جدا .. هل هذا حيض ؟');
  await evalJs(`document.querySelector('input[placeholder*="اكتب رسالتك"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await waitFor(`!!(${CARD}) && !!(${CARD}).querySelector('input[placeholder*="أدخل التاريخ"]')`, 25000);
  await sleep(700);
  let s1 = await evalJs(SNAPSHOT);
  const emptyBubbles1 = s1.bubbles.filter((b) => !b).length;
  rec(`${mode}: no empty assistant bubble`, emptyBubbles1 === 0, JSON.stringify(s1.bubbles));
  rec(`${mode}: Q1 question visible`, s1.cardText.includes('في أي تاريخ بدأ الحدث؟'));
  rec(`${mode}: date control is labeled with its question`, s1.controls.length === 1 && s1.controls[0].label.includes('في أي تاريخ بدأ الحدث؟'), JSON.stringify(s1.controls));
  rec(`${mode}: progress chips are real stages`, s1.stages.length >= 3, JSON.stringify(s1.stages));
  rec(`${mode}: composer remains usable`, s1.footerUsable);

  // ---- TURN 2 (structured answer)
  await setInput('input[placeholder*="أدخل التاريخ"]', '2026-09-16');
  await clickText('إرسال');
  await waitFor(`!!(${CARD}) && !!(${CARD}).querySelector('input[placeholder*="أدخل قيمة"]')`, 25000);
  await sleep(700);
  const s2 = await evalJs(SNAPSHOT);
  rec(`${mode}: no empty assistant bubble after the answer`, s2.bubbles.filter((b) => !b).length === 0, JSON.stringify(s2.bubbles));
  rec(`${mode}: Q2 question visible (no dead end)`, s2.cardText.includes('كم يوماً استمر هذا الحدث؟'));
  rec(`${mode}: numeric control is labeled (NO naked أدخل قيمة)`, s2.controls.length === 1 && s2.controls[0].label.includes('كم يوماً استمر هذا الحدث؟'), JSON.stringify(s2.controls));

  // ---- TURN 3 (terminal)
  await setInput('input[placeholder*="أدخل قيمة"]', '6');
  await clickText('إرسال');
  const terminal = await waitFor(`(${CARD}).innerText.includes('تمت معالجة طلبك')`, 25000);
  await sleep(700);
  const s3 = await evalJs(SNAPSHOT);
  rec(`${mode}: reaches the terminal state`, terminal);
  rec(`${mode}: no empty assistant bubble at the end`, s3.bubbles.filter((b) => !b).length === 0);
  rec(`${mode}: no structured control left unexplained`, s3.controls.every((c) => c.label.length > 0), JSON.stringify(s3.controls));
  rec(`${mode}: feedback control appears at the terminal state`, s3.cardText.includes('هل النتيجة صحيحة') || (await evalJs(`document.body.innerText.includes('هل النتيجة صحيحة؟')`)));
  rec(`${mode}: composer still usable`, s3.footerUsable);
}

(async () => {
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(300); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
    await cdp('Page.enable'); await cdp('Runtime.enable');

    await cdp('Page.navigate', { url: BASE + '/tests' });
    await sleep(2500);
    if (await evalJs(`!!document.querySelector('input[type=email]')`)) {
      await setInput('input[type=email]', EMAIL);
      await setInput('input[type=password]', PASSWORD);
      await evalJs(`document.querySelector('form').requestSubmit()`);
    }
    await waitFor(`!document.querySelector('input[type=email]')`, 25000);
    await evalJs(`localStorage.setItem('kip.activeProjectId', '${PROJECT}')`);
    await cdp('Page.navigate', { url: BASE + '/tests' });
    await sleep(2500);
    await waitFor(`document.body.innerText.includes('محادثة جديدة')`, 20000);

    await runMode('private');
    await runMode('contextual');

    if (SHOT) {
      const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log('  screenshot =', SHOT);
    }
    const fails = results.filter(([, c]) => !c);
    console.log(`\nSUMMARY: PASS ${results.length - fails.length}/${results.length}`);
    fails.forEach(([n]) => console.log('FAIL:', n));
    process.exit(fails.length ? 1 : 0);
  } catch (e) { console.error('E2E ERROR:', e.message); process.exit(1); }
})();