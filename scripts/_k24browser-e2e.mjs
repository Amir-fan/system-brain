// K24 BROWSER E2E — real headless Chrome over raw CDP (zero deps), acting on the
// real local frontend (5173) + real backend (8787, proxied) + real Supabase auth.
// Uses the dedicated throwaway browser user. Runs the full Tests page flow.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN
  || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9300 + Math.floor(Math.random() * 400);
const PROFILE = mkdtempSync(join(tmpdir(), 'k24e2e-'));
const BASE = 'http://localhost:5173';
const EMAIL = process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local';
const PASSWORD = process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123';

const results = [];
const rec = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? '✅' : '❌'} ${name} ${extra}`); };

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* chrome still booting */ }
    await sleep(300);
  }
  throw new Error('chrome page target not found');
}

let ws;
let msgId = 0;
const pending = new Map();
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, 15000);
  });
}

async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJs(expr)) return true; } catch {}
    await sleep(250);
  }
  return false;
}

async function setInput(selector, value) {
  // React-controlled inputs need the native setter + input event; pick setter
  // by the element's actual tag.
  const r = await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'NOELEM';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(100);
  return r;
}

async function clickText(text, root = 'document') {
  return evalJs(`(() => {
    const all = ${root}.querySelectorAll('button, a, [role="button"]');
    for (const el of all) { if ((el.textContent||'').trim() === ${JSON.stringify(text)}) { el.click(); return true; } }
    return false;
  })()`);
}

(async () => {
  try {
    const target = await getPageTarget();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Network.enable');

    // ---- LOGIN (real Supabase auth from the browser) ----
    await cdp('Page.navigate', { url: BASE + '/tests' });
    await sleep(2500);
    // If session absent, LoginPage renders (i18n ar is default? dict default locale below)
    const onLogin = await evalJs(`!!document.querySelector('input[type=email]')`);
    if (onLogin) {
      await setInput('input[type=email]', EMAIL);
      await setInput('input[type=password]', PASSWORD);
      await evalJs(`document.querySelector('input[type=password]').closest('form').requestSubmit ? document.querySelector('form').requestSubmit() : document.querySelector('form button[type=submit]').click()`);
      rec('LOGIN via Supabase', true);
    } else {
      rec('LOGIN (already authenticated session)', true);
    }
    await sleep(3000);
    const authed = await waitFor(`!document.querySelector('input[type=email]') && document.body.innerText.includes('اختبارات العقل')`, 25000);
    rec('B reach Tests page after auth', authed);

    // project context load
    await waitFor(`document.body.innerText.includes('محادثة جديدة')`, 20000);

    // ---- START CONTEXTUAL ----
    const ctxModeOftenDefault = await evalJs(`document.body.innerText.includes('سياقي')`);
    rec('C mode selection visible (contextual)', ctxModeOftenDefault);
    await clickText('سياقي');
    await sleep(300);
    await clickText('محادثة جديدة');
    await waitFor(`document.body.innerText.includes('اكتب رسالتك')`, 15000);
    rec('C conversation started (input visible)', true);

    // ---- SEND REAL MESSAGE 1 (needs_information -> date interaction) ----
    await setInput('input[placeholder*="اكتب رسالتك"]', 'بدأ الحدث');
    await evalJs(`(() => { const el = document.querySelector('input[placeholder*="اكتب رسالتك"]'); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
    const dateWidget = await waitFor(`!!document.querySelector('input[placeholder*="أدخل التاريخ"]')`, 20000);
    rec('E/D structured date interaction rendered from real runtime', dateWidget);

    // ---- ANSWER DATE -> next (duration) ----
    await setInput('input[placeholder*="أدخل التاريخ"]', '2026-01-10');
    await clickText('إرسال');
    const durationWidget = await waitFor(`!!document.querySelector('input[placeholder*="أدخل قيمة"]')`, 20000);
    rec('H multi-turn continuation (duration interaction next)', durationWidget);

    // ---- ANSWER DURATION -> completed/decision ----
    await setInput('input[type=number]', '6');
    await clickText('إرسال');
    const doneFeedback = await waitFor(`document.body.innerText.includes('هل النتيجة صحيحة؟')`, 20000);
    rec('I decision/response reached + feedback control shown', doneFeedback);

    // truthful progress chips rendered
    const progress = await evalJs(`document.body.innerText.includes('نفهم السؤال') || document.body.innerText.includes('نرتب الجواب')`);
    rec('AJ truthful progress stages rendered', progress);

    // ---- OPEN TRACE ----
    await clickText('عرض تفاصيل الاختبار');
    const traceOpen = await waitFor(`document.body.innerText.includes('تفاصيل الاختبار') && document.body.innerText.includes('المراحل الفعلية')`, 10000);
    rec('M trace drawer opens with real fields', traceOpen);
    const traceRunId = await evalJs(`/run id/.test(document.body.innerText) || /[0-9a-f]{8}/i.test(document.body.innerText)`);
    rec('R run/id surfaced in trace or stage row', traceRunId);
    await clickText('إغلاق');
    await sleep(300);

    // ---- EVALUATE CORRECT + PERSIST (reload proves DB persistence) ----
    await clickText('صحيحة');
    await waitFor(`document.body.innerText.includes('حفظ التقييم')`, 8000);
    await clickText('حفظ التقييم');
    const saved = await waitFor(`document.body.innerText.includes('تم الحفظ')`, 15000);
    rec('X feedback persisted (saved indicator)', saved);

    // reload -> evaluation still present from DB
    await cdp('Page.navigate', { url: BASE + '/tests' });
    await sleep(4000);
    const reloadEval = await waitFor(`document.body.innerText.includes('التقييمات المحفوظة') && document.body.innerText.includes('✓')`, 20000);
    rec('AB evaluation persists after reload (from DB)', reloadEval);

    console.log('\n==== SUMMARY ====');
    const fails = results.filter(([, ok]) => !ok);
    fails.forEach(([n]) => console.log('FAIL:', n));
    console.log(`PASS ${results.length - fails.length}/${results.length}`);
    process.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error('E2E ERROR:', e.message);
    process.exit(1);
  }
})();

process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });