// Knowledge Sources layout — LIVE BROWSER E2E (real frontend + backend + Supabase).
// Proves column layout, always-visible names, no overflow, and that the row
// actions still work. Writes a screenshot for the report.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9700 + Math.floor(Math.random() * 200);
const PROFILE = mkdtempSync(join(tmpdir(), 'kx-'));
const BASE = 'http://127.0.0.1:5173';
const PROJECT = '7e73c7a3-4973-4a6f-849b-ec84988a3d14';
const EMAIL = process.env.K24_E2E_EMAIL ?? 'k24.browser@test.local';
const PASSWORD = process.env.K24_E2E_PASSWORD ?? 'K24Test!pass123';
const WIDTH = Number(process.argv[2] ?? 1440);
const SHOT = process.argv[3] ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (n, ok, extra = '') => { results.push([n, ok]); console.log(`${ok ? '✅' : '❌'} ${n} ${extra}`); };

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu', `--window-size=${WIDTH},1000`, '--no-first-run', `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch {} });

let ws; let id = 0; const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => { const m = ++id; pending.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })); setTimeout(() => pending.has(m) && (pending.delete(m), rej(new Error('t/o ' + method))), 25000); });
const evalJs = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
async function waitFor(expr, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJs(expr)) return true; } catch {} await sleep(300); } return false; }
const setInput = (sel, v) => evalJs(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'NOELEM';
  const p = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(p,'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);

// row-scoped helpers: find the <li> whose text contains the source title
const ROW = (title) => `[...document.querySelectorAll('ul > li')].find(li => (li.innerText||'').includes(${JSON.stringify(title)}))`;

(async () => {
  try {
    let target;
    for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(300); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
    await cdp('Page.enable'); await cdp('Runtime.enable');

    await cdp('Page.navigate', { url: BASE + '/knowledge' });
    await sleep(2500);
    if (await evalJs(`!!document.querySelector('input[type=email]')`)) {
      await setInput('input[type=email]', EMAIL);
      await setInput('input[type=password]', PASSWORD);
      await evalJs(`document.querySelector('form').requestSubmit()`);
    }
    await waitFor(`!document.querySelector('input[type=email]')`, 25000);
    await evalJs(`localStorage.setItem('kip.activeProjectId', '${PROJECT}')`);
    await cdp('Page.navigate', { url: BASE + '/knowledge' });
    await sleep(3000);
    await waitFor(`document.body.innerText.includes('الحيض')`, 25000);
    await waitFor(`document.body.innerText.includes('جاهز للبحث')`, 30000); // index badges settled
    await sleep(1200);

    // ---- 1. every row has a visible name ----
    const names = await evalJs(`(() => {
      const rows = [...document.querySelectorAll('ul > li')];
      return rows.map(li => {
        const n = [...li.querySelectorAll('div')].find(d => String(d.className||'').includes('font-semibold') && String(d.className||'').includes('truncate'));
        const r = n ? n.getBoundingClientRect() : null;
        return { text: n ? (n.innerText||'').trim() : null, w: r ? Math.round(r.width) : 0, title: n ? n.getAttribute('title') : null };
      }); })()`);
    const allNamed = names.length > 0 && names.every((n) => n.text && n.text.length > 0 && n.w > 40);
    rec(`all ${names.length} source rows have a visible name`, allNamed);
    rec('every name carries a full-text tooltip', names.every((n) => n.title));
    const required = ['المذاهب الاربعة', 'الافاضة', 'الحيض الالوكة'];
    rec('required sources are all present and named', required.every((r) => names.some((n) => (n.text || '').includes(r))));

    // ---- 2/3/4. no overflow ----
    const geo = await evalJs(`(() => {
      const card = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('rounded-xl2') && d.querySelector('ul'));
      const cr = card.getBoundingClientRect();
      const rows = [...card.querySelectorAll('ul > li')];
      const outside = rows.filter(li => { const r = li.getBoundingClientRect(); return r.left < cr.left - 1 || r.right > cr.right + 1; }).length;
      const inner = rows.filter(li => li.scrollWidth > li.clientWidth + 1).length;
      const controlsOutside = [...card.querySelectorAll('button, select')].filter(el => { const r = el.getBoundingClientRect(); return r.left < cr.left - 1 || r.right > cr.right + 1; }).length;
      return { outside, inner, controlsOutside, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
               cardLeft: Math.round(cr.left), cardRight: Math.round(cr.right) }; })()`);
    rec('no row extends outside the white card', geo.outside === 0, JSON.stringify(geo));
    rec('no row overflows its own box', geo.inner === 0);
    rec('no button/select extends outside the card', geo.controlsOutside === 0);
    rec('no horizontal page scrollbar from the list', geo.pageOverflow === false);

    // ---- 5. columns align (same left offsets across rows at desktop) ----
    if (WIDTH >= 1280) {
      const aligns = await evalJs(`(() => {
        const rows = [...document.querySelectorAll('ul > li')];
        const offsets = rows.map(li => [...li.children].map(c => Math.round(c.getBoundingClientRect().left)).join(','));
        return new Set(offsets).size; })()`);
      rec('column edges align across rows', aligns === 1, `distinct offsets=${aligns}`);
    }

    // ---- 6. error text readable ----
    const err = await evalJs(`(() => {
      const li = ${ROW('الافاضة')};
      const p = li ? li.querySelector('p') : null;
      if (!p) return null;
      const cs = getComputedStyle(p);
      return { text: (p.innerText||'').trim(), size: parseFloat(cs.fontSize), lh: cs.lineHeight, clipped: p.scrollHeight > p.clientHeight + 2 }; })()`);
    console.log('  error cell =', JSON.stringify(err));
    rec('failure reason is rendered on the row', !!err && err.text.includes('OCR'));
    rec('failure reason is readable (font-size >= 10px)', !!err && err.size >= 10);

    // ---- 7. role dropdowns usable (present, enabled, 3 options) ----
    const roles = await evalJs(`(() => {
      const sels = [...document.querySelectorAll('ul > li select')];
      return sels.map(s => ({ v: s.value, opts: s.options.length, enabled: !s.disabled, w: Math.round(s.getBoundingClientRect().width) })); })()`);
    rec('role dropdowns present, enabled, bounded', roles.length > 0 && roles.every((r) => r.enabled && r.opts === 3 && r.w <= 96), JSON.stringify(roles[0] ?? null));

    // ---- 8. actions still work ----
    // 8a. documents action (completed source) opens the drawer
    await evalJs(`(() => { const li = ${ROW('الحيض الالوكة')}; const b = li && li.querySelector('button[title]'); b && b.click(); })()`);
    const drawer = await waitFor(`document.body.innerText.includes('مستندات المصدر') || document.body.innerText.includes('المستندات')`, 12000);
    rec('documents action still works (drawer opens)', drawer);
    await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').includes('إغلاق')); b && b.click(); })()`);
    await sleep(600);

    // 8b. ⋮ menu opens with the secondary actions
    await evalJs(`(() => { const li = ${ROW('الحيض الالوكة')}; const b = li && li.querySelector('button[aria-haspopup="menu"]'); b && b.click(); })()`);
    const menuOpen = await waitFor(`!!document.querySelector('[role="menu"]')`, 8000);
    const menuItems = await evalJs(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => (b.innerText||'').trim())`);
    console.log('  menu items =', JSON.stringify(menuItems));
    rec('row actions menu opens', menuOpen);
    rec('menu carries the index + archive actions', menuItems.some((x) => x.includes('فهرسة') || x.includes('الفهرسة') || x.includes('إعادة')) && menuItems.some((x) => x.includes('أرشفة')));

    // 8c. index action from the menu runs (idempotent: already ready)
    const clickedIdx = await evalJs(`(() => { const it = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(b => (b.innerText||'').includes('فهرسة') || (b.innerText||'').includes('إعادة')); if (!it) return false; it.click(); return true; })()`);
    const idxSettled = await waitFor(`!document.querySelector('[role="menu"]')`, 8000);
    rec('index action from the menu still works', clickedIdx && idxSettled);
    await sleep(2500);

    // 8d. Escape closes the menu
    await evalJs(`(() => { const li = ${ROW('الأفاضة')} || ${ROW('الافاضة')}; const b = li && li.querySelector('button[aria-haspopup="menu"]'); b && b.click(); })()`);
    await waitFor(`!!document.querySelector('[role="menu"]')`, 6000);
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    const closed = await waitFor(`!document.querySelector('[role="menu"]')`, 6000);
    rec('Escape closes the row menu', closed);

    // ---- 9/10. truthful states ----
    const docxRow = await evalJs(`(${ROW('الحيض الالوكة')} || {}).innerText || ''`);
    const pdfRow = await evalJs(`(${ROW('الافاضة')} || {}).innerText || ''`);
    const mazaRow = await evalJs(`(${ROW('المذاهب الاربعة')} || {}).innerText || ''`);
    console.log('  DOCX row =', JSON.stringify(docxRow.replace(/\s+/g, ' ').slice(0, 150)));
    console.log('  PDF row  =', JSON.stringify(pdfRow.replace(/\s+/g, ' ').slice(0, 150)));
    rec('الحيض الالوكة shows name + processed + ready', docxRow.includes('الحيض الالوكة') && docxRow.includes('تمت معالجة المحتوى') && docxRow.includes('جاهز للبحث'));
    rec('الافاضة shows name + truthful OCR reason', pdfRow.includes('الافاضة') && pdfRow.includes('OCR'));
    rec('المذاهب الاربعة shows name + truthful OCR reason', mazaRow.includes('المذاهب الاربعة') && mazaRow.includes('OCR'));

    if (SHOT) {
      const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log('  screenshot =', SHOT);
    }

    const fails = results.filter(([, ok]) => !ok);
    console.log(`\nSUMMARY: PASS ${results.length - fails.length}/${results.length}`);
    fails.forEach(([n]) => console.log('FAIL:', n));
    process.exit(fails.length ? 1 : 0);
  } catch (e) { console.error('E2E ERROR:', e.message); process.exit(1); }
})();