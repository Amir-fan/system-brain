/**
 * K14 provisioning (throwaway): restore the OpenRouter credential into Vault via
 * the CANONICAL admin connect path. The credential is read from the local env in
 * process and never printed, logged or written to any tracked file.
 */
const BASE = process.env.KIP_PUBLIC_API_URL ?? process.env.KIP_PUBLIC_API_URL_LOCAL ?? 'http://localhost:8787';
const admin = process.env.KIP_PLATFORM_ADMIN_TOKEN;
const key = process.env.OPENROUTER_TEST_KEY;

console.log('admin token present:', Boolean(admin));
console.log('candidate credential present (len):', key ? String(key).length : 0);

const res = await fetch(`${BASE}/v1/admin/providers`, {
  method: 'POST',
  headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
  body: JSON.stringify({ providerKey: 'openrouter', apiKey: key }),
});
const body = await res.json().catch(() => ({}));
console.log('connect status:', res.status, '| ok:', body.ok, '| masked:', body.data?.maskedKey, '| configured:', body.data?.credentialConfigured);

// Zero-cost verification of the stored credential.
const test = await fetch(`${BASE}/v1/admin/providers/openrouter/test`, {
  method: 'POST',
  headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
  body: '{}',
});
const tb = await test.json().catch(() => ({}));
console.log('validate status:', test.status, '| ok:', tb.ok, '| result:', JSON.stringify(tb.data ?? tb.error).slice(0, 120));

// Embedding catalog must be reachable and offer the approved model.
const cat = await fetch(`${BASE}/v1/admin/providers/openrouter/embedding-models`, {
  headers: { authorization: `Bearer ${admin}` },
});
const cb = await cat.json().catch(() => ({}));
const models = (cb.data?.models ?? []).map((m) => `${m.id}${m.approved ? '*' : ''}${m.assignable ? '' : '(n/a)'}`);
console.log('embedding catalog status:', cat.status, '| locked:', cb.data?.lockedDimensions, '| assignable:', cb.data?.assignableCount);
console.log('embedding models:', models.join(', '));
