// K21 FINAL SCANNER LIVE VISION E2E — real media through naqaa.scanner via the real KIP path.
import { createClient } from '@supabase/supabase-js';
import zlib from 'node:zlib';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const B = 'http://localhost:8787';
const s = await user.auth.signInWithPassword({ email: 'muslem26@gmail.com', password: process.env.KIP_DEMO_PASSWORD });
const H = { authorization: 'Bearer ' + s.data.session.access_token, 'content-type': 'application/json' };
const P = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data[0].id;

function padPng() {
  const w = 180, h = 180;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      // light cream pad background with a central reddish stain
      const dx = x - 90, dy = y - 95;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 40) { raw[o] = 190; raw[o + 1] = 45; raw[o + 2] = 45; raw[o + 3] = 255; }
      else if (d < 52) { raw[o] = 215; raw[o + 1] = 90; raw[o + 2] = 80; raw[o + 3] = 255; }
      else { raw[o] = 245; raw[o + 1] = 240; raw[o + 2] = 235; raw[o + 3] = 255; }
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

const exec = async (body) => (await fetch(`${B}/v1/projects/${P}/skills/naqaa.scanner/execute`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json();
const PWA = (m, ok) => console.log(m, '| PASS =', ok);

// SUFFICIENT: with cycleDay
{
  const r = await exec({ payload: { media: { dataUrl: padPng() }, context: { cycleDay: '3' } } });
  const d = r.data?.output;
  const o = d?.observation;
  const groups = o && ['color', 'physical', 'texture', 'spatial', 'contextual'].every((k) => o[k]);
  const noFiqh = o && !/hayd|istihada|nifas|purity|prayer|fasting|حيض|استحاضة|نفاس|طهارة|صلاة|صوم/.test(JSON.stringify(o));
  const physUnavail = o?.physical?.viscosity?.status === 'unavailable';
  console.log('status=' + d?.status + ' sufficiency=' + d?.sufficiency + ' questionNeeded=' + d?.questionNeeded);
  console.log('dominantColor=' + JSON.stringify(o?.color?.dominantColor) + ' viscosity=' + JSON.stringify(o?.physical?.viscosity?.status));
  console.log('modelInfo=' + JSON.stringify(d?.modelInfo) + ' observability=' + JSON.stringify(d?.observability));
  PWA('H SUFFICIENT scanner: completed + 5 groups + no-fiqh + physical-unavailable', d?.status === 'completed' && d?.sufficiency === 'sufficient' && groups && noFiqh && physUnavail);
  PWA('L observability: visionCalls=1 + modelInfo present', d?.observability?.visionCalls === 1 && !!d?.modelInfo?.model);
}
// NEEDS_INFORMATION: no cycleDay
{
  const r = await exec({ payload: { media: { dataUrl: padPng() } } });
  const d = r.data?.output;
  console.log('G status=' + d?.status + ' questionNeeded=' + d?.questionNeeded + ' missing=' + JSON.stringify(d?.missingInformation?.map((m) => m.key)) + ' question=' + d?.question?.key);
  PWA('G MISSING INFO: needs_information + questionNeeded + one question', d?.status === 'needs_information' && d?.questionNeeded === true && d?.missingInformation?.length >= 1 && d?.question?.key === 'cycle_day');
}
