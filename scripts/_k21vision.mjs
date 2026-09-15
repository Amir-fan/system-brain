// K21 VISION FEASIBILITY GATE — real image through KIP Model Gateway -> Assignment -> Provider.
import { createClient } from '@supabase/supabase-js';
import zlib from 'node:zlib';
import { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

function redPngDataUrl() {
  // 8x8 solid red RGBA PNG via zlib deflate of raw scanlines.
  const w = 8, h = 8;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 4) + 1 + x * 4;
      raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30; raw[o + 3] = 255; // red
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

const gateway = new OpenRouterGateway({ apiKey: process.env.OPENROUTER_TEST_KEY, defaultModel: 'openrouter/auto' });

// 1. ensure a vision_scan assignment exists (control-plane data)
let asn = (await admin.from('model_assignments').select('*').eq('workload_key', 'vision_scan').maybeSingle()).data;
if (!asn) {
  const ins = await admin.from('model_assignments').insert({ workload_key: 'vision_scan', provider_key: 'openrouter', model_id: 'google/gemini-3.5-flash', is_active: true }).select('*').single();
  asn = ins.data; console.log('created vision_scan assignment:', asn?.model_id);
} else {
  console.log('existing vision_scan assignment:', asn.model_id);
}
const modelId = asn.model_id;

// 2. REAL call: image + text through the gateway
const img = redPngDataUrl();
const out = await gateway.generateText({
  projectId: 'feasibility', runId: 'vision-gate-' + Date.now(), capability: 'feasibility',
  modelId,
  input: {
    parts: [
      { type: 'text', text: 'Look at the image and return ONLY a compact JSON object like {"dominantColor":"red","isUniform":true}. No other text.' },
      { type: 'image', dataUrl: img },
    ],
  },
});
console.log('VISION GATE output =', JSON.stringify(out.text).slice(0, 300));
console.log('VISION GATE model =', out.model, '| provider =', out.provider, '| usage =', JSON.stringify(out.usage));
