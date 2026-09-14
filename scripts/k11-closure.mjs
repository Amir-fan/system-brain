// K11 live closure: URL acquisition, SSRF protection, GitHub acquisition, determinism.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createSign, createHash } from 'node:crypto';

const BASE = 'http://localhost:8787';
const EMAIL = 'muslem26@gmail.com';
const PASSWORD = process.env.KIP_DEMO_PASSWORD;

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const session = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (!session.data.session) throw new Error('signin failed');
const H = { authorization: 'Bearer ' + session.data.session.access_token, 'content-type': 'application/json' };

const results = [];
const mark = (label, pass) => { results.push((pass ? 'PASS ' : 'FAIL ') + label); return pass; };
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const project = (await admin.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data[0];
const at = (p) => admin.from(p);

async function registerUrl(url, title) {
  const r = await call('POST', `/v1/projects/${project.id}/sources`, { sourceType: 'url', title, externalUri: url });
  return r.body.data?.id;
}
async function runIngestion(sourceId) {
  const r = await call('POST', `/v1/projects/${project.id}/sources/${sourceId}/ingestions`, {});
  return { status: r.status, job: r.body.data?.job, reused: r.body.data?.reused };
}
const outputFor = async (sourceId) =>
  (await admin.from('ingestion_outputs').select('normalized_text, content_sha256, char_count').eq('source_id', sourceId).order('created_at', { ascending: false }).limit(1)).data?.[0];

// ---------------------------------------------------------------- CP1: real URL
const urlSource = await registerUrl('https://example.com', 'K11 Example URL');
const urlRun = await runIngestion(urlSource);
mark('CP1 real URL acquisition completed', urlRun.status === 201 && urlRun.job?.status === 'completed');
const urlOut = await outputFor(urlSource);
mark('CP1 normalized text is the real page (Example Domain)', typeof urlOut?.normalized_text === 'string' && urlOut.normalized_text.includes('Example Domain'));
mark('CP1 SHA-256 persisted and matches sha256(normalized)', urlOut?.content_sha256 === createHash('sha256').update(urlOut?.normalized_text ?? '', 'utf8').digest('hex'));
mark('CP1 no HTML markup survived extraction', !/<[a-z][^>]*>/i.test(urlOut?.normalized_text ?? ''));

// ---------------------------------------------------------------- CP2: SSRF
const blocked = [
  ['localhost', 'http://localhost/'],
  ['127.0.0.1', 'http://127.0.0.1/'],
  ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['RFC1918 private', 'http://192.168.1.10/admin'],
];
for (const pair of blocked) {
  const label = pair[0];
  const target = pair[1];
  const src = await registerUrl(target, 'K11 blocked ' + label);
  const run = await runIngestion(src);
  const row = (await admin.from('ingestion_jobs').select('status, error_code').eq('source_id', src).maybeSingle()).data;
  mark('CP2 SSRF blocked: ' + label, row?.status === 'failed' && row?.error_code === 'URL_BLOCKED');
}

// ---------------------------------------------------------------- CP3/CP4: real GitHub
function appJwt() {
  const pem = readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(h + '.' + p);
  return h + '.' + p + '.' + signer.sign(createPrivateKey(pem)).toString('base64url');
}
async function installationToken() {
  const conn = (await admin.from('external_connections').select('external_account_id').eq('project_id', project.id).eq('provider', 'github')).data[0];
  const res = await fetch('https://api.github.com/app/installations/' + conn.external_account_id + '/access_tokens', {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'kip-next', authorization: 'Bearer ' + appJwt() },
  });
  return { token: (await res.json()).token, installationId: conn.external_account_id };
}

const ghSource = (await admin.from('sources').select('id,title').eq('project_id', project.id).eq('source_type', 'github').maybeSingle()).data;
mark('CP3 a real GitHub source is registered', !!ghSource);
const ghRun = await runIngestion(ghSource.id);
mark('CP3 GitHub acquisition completed via the real installation', ghRun.status === 201 && ghRun.job?.status === 'completed');
const ghOut = await outputFor(ghSource.id);
const ghText = ghOut?.normalized_text ?? '';
mark('CP3 GitHub output is non-trivial', ghText.length > 1000);

// ground truth straight from GitHub, independent of KIP's ingestion path
const { token } = await installationToken();
const readmeRes = await fetch('https://api.github.com/repos/bolaith/kip-next/contents/README.md', {
  headers: { accept: 'application/vnd.github+json', 'user-agent': 'kip-next', authorization: 'Bearer ' + token },
});
const readmeB64 = (await readmeRes.json()).content ?? '';
const readme = Buffer.from(readmeB64, 'base64').toString('utf8');
const readmeLines = readme.split('\n').map((l) => l.trim()).filter((l) => l.length > 12);
const marker = readmeLines.find((l) => ghText.includes(l));
mark('CP4 real README.md content is present in the acquired output', ghText.includes('--- FILE: README.md ---') && !!marker);
console.log('   verified README line present:', JSON.stringify((marker ?? '').slice(0, 60)));
const fileMarkers = ghText.split('--- FILE: ').length - 1;
mark('CP4 repository paths are preserved and ordered', ghText.includes('--- FILE: ') && fileMarkers > 1);
mark('CP6 GitHub acquisition is bounded (<= 40 files)', fileMarkers <= 40);
mark('CP6 GitHub output is bounded (< 2MB)', Buffer.byteLength(ghText, 'utf8') < 2_000_000);

// ---------------------------------------------------------------- CP5: secret exclusion
// Real secret MATERIAL only. A configuration file legitimately MENTIONING the
// filename '.env.local' (e.g. package.json's --env-file flag) is not a leak;
// secret FILES are checked separately via the acquired path markers below.
const secretProbes = ['PRIVATE KEY', 'BEGIN RSA', 'BEGIN OPENSSH', 'ghs_', 'ghp_'];
const leaked = secretProbes.filter((p) => ghText.includes(p));
mark('CP5 no secret-like file or content acquired from the repository', leaked.length === 0 );
if (leaked.length) console.log('   LEAKED:', leaked.join(', '));
mark('CP5 acquired paths exclude .env / pem / key files', !/--- FILE: [^\n]*(\.env|\.pem|\.key|id_rsa)/i.test(ghText));

mark('CP5 no real key-shaped secret value present', !/sb_secret_[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}/.test(ghText));
mark('CP5 vendored dot-directories are not acquired', !ghText.includes('--- FILE: .agents/') && !ghText.includes('--- FILE: .github/'));

// ---------------------------------------------------------------- CP7: determinism
const urlAgain = await runIngestion(urlSource);
const urlOut2 = await outputFor(urlSource);
mark('CP7 URL re-acquisition is idempotent (same normalized hash)', urlAgain.job?.status === 'completed' && urlOut2?.content_sha256 === urlOut?.content_sha256);
const ghAgain = await runIngestion(ghSource.id);
const ghOut2 = await outputFor(ghSource.id);
mark('CP7 GitHub re-acquisition is deterministic (same normalized hash)', ghAgain.job?.status === 'completed' && ghOut2?.content_sha256 === ghOut?.content_sha256);

// ---------------------------------------------------------------- CP8: isolation
const other = (await admin.from('projects').insert({ name: 'K11 Isolation Project' }).select('id')).data[0];
const uid = (await admin.auth.admin.listUsers()).data.users.find((u) => u.email === EMAIL).id;
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: uid, role: 'owner' });

const bTrigger = await call('POST', `/v1/projects/${other.id}/sources/${urlSource}/ingestions`, {});
mark('CP8 project B cannot trigger project A acquisition', bTrigger.status === 404 || bTrigger.status === 403);
const bJobs = await call('GET', `/v1/projects/${other.id}/ingestions`);
mark('CP8 project B sees no project A ingestion', bJobs.status === 200 && (bJobs.body.data ?? []).length === 0);
const bConns = await call('GET', `/v1/projects/${other.id}/connections`);
mark('CP8 project B has no GitHub connection', bConns.status === 200 && (bConns.body.data ?? []).length === 0);
const bSource = await call('GET', `/v1/projects/${other.id}/sources`);
mark('CP8 project B cannot list project A sources', bSource.status === 200 && (bSource.body.data ?? []).length === 0);

// ---------------------------------------------------------------- CP9: failure path
const missing = await registerUrl('https://example.com/kip-404-does-not-exist', 'K11 404 URL');
const missingRun = await runIngestion(missing);
const missingRow = (await admin.from('ingestion_jobs').select('status, error_code, error_message').eq('source_id', missing).maybeSingle()).data;
mark('CP9 missing URL fails safely with a typed code', missingRow?.status === 'failed' && missingRow?.error_code === 'URL_FETCH_FAILED');
mark('CP9 failure message is user-safe (no stack/url internals)', typeof missingRow?.error_message === 'string' && missingRow.error_message.length > 0 && !/http|Error|stack/i.test(missingRow.error_message));

// ---------------------------------------------------------------- cleanup (test residue only)
const urlTestSources = (await admin.from('sources').select('id, source_type').eq('project_id', project.id)).data ?? [];
for (const s of urlTestSources) {
  if (s.source_type !== 'url') continue;
  await admin.from('ingestion_outputs').delete().eq('source_id', s.id);
  await admin.from('ingestion_jobs').delete().eq('source_id', s.id);
  await admin.from('sources').delete().eq('id', s.id);
}
await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);
const left = (await admin.from('sources').select('id, source_type').eq('project_id', project.id)).data ?? [];
mark('CLEANUP url test sources removed; GitHub source intentionally kept', left.length === 1 && left[0].source_type === 'github');
mark('CLEANUP isolation project removed', ((await admin.from('projects').select('id').eq('name', 'K11 Isolation Project')).data ?? []).length === 0);

console.log(results.join('\n'));
console.log('ALL_PASS ' + results.every((r) => r.startsWith('PASS')));
