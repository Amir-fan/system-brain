// K7 closure: real installation, real repository API, registration, isolation, security.
import { createClient } from '@supabase/supabase-js';

const BASE = 'http://localhost:8787';
const EMAIL = 'muslem26@gmail.com';
const PASSWORD = process.env.KIP_DEMO_PASSWORD;

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY);
const s = await user.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (!s.data.session) throw new Error('signin failed');
const token = s.data.session.access_token;
const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

const results = [];
const mark = (label, pass) => { results.push((pass ? 'PASS ' : 'FAIL ') + label); return pass; };
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const project = (await admin.from('projects').select('id,name').eq('name', 'KIP Demo Project')).data[0];
console.log('project:', project.name, project.id);

// --- 1. real installation + real repository list
const conn = (await admin.from('external_connections').select('provider,status,external_account_id,external_account_label,secure_secret_reference').eq('project_id', project.id).eq('provider', 'github').maybeSingle()).data;
mark('1 external_connections holds a real connected installation', conn?.status === 'connected' && !!conn?.external_account_id && conn?.external_account_label === 'bolaith');
mark('1 no secret reference stored for the connection', conn?.secure_secret_reference === null);
console.log('   installation_id=' + conn?.external_account_id + ' account=' + conn?.external_account_label);

const repos = await call('GET', `/v1/projects/${project.id}/connections/github/repositories`);
const list = repos.body.data ?? [];
mark('1 real repository API returns 200', repos.status === 200);
mark('1 repository list is non-empty (real installation repos)', Array.isArray(list) && list.length > 0);
console.log('   repositories (' + list.length + '): ' + list.map((r) => r.name).join(', '));
mark('1 every entry carries repo id/name/url/default branch', list.every((r) => r.itemId || r.id) && list.every((r) => typeof r.name === 'string' && r.name.includes('/')) && list.every((r) => typeof r.detail === 'string'));
mark('1 bolaith/kip-next is among the authorized repositories', list.some((r) => r.name === 'bolaith/kip-next'));
mark('1 no token/secret fields in the response', !/token|secret|jwt|authorization/i.test(JSON.stringify(list)));

// --- 3. register a real repository through the real API path the UI uses
const target = list.find((r) => r.name === 'bolaith/kip-next') ?? list[0];
const reg = await call('POST', `/v1/projects/${project.id}/sources/github`, {
  itemId: target.itemId ?? target.id,
  itemType: 'repository',
  name: target.name,
  uri: target.uri,
  detail: target.detail,
});
mark('3 register repository source (201)', reg.status === 201);
const srcId = reg.body.data?.id;

const srcRow = (await admin.from('sources').select('id, source_type, title, external_uri, status').eq('id', srcId).maybeSingle()).data;
mark('3 sources row: type github, title owner/name, canonical URL', srcRow?.source_type === 'github' && srcRow?.title === target.name && srcRow?.external_uri === target.uri);

const refRow = (await admin.from('external_source_references').select('provider, external_item_id, external_type, external_uri, display_name, external_path, connection_id, source_id').eq('source_id', srcId).maybeSingle()).data;
mark('3 external_source_references: provider/repo id/url/default branch/connection', refRow?.provider === 'github' && refRow?.external_item_id === String(target.itemId ?? target.id) && refRow?.external_type === 'repository' && refRow?.external_uri === target.uri && refRow?.display_name === target.name && refRow?.external_path === target.detail && !!refRow?.connection_id);

// no credential material persisted anywhere on the source/reference
const blob = JSON.stringify({ srcRow, refRow });
mark('3 no token/jwt/secret persisted on source or reference', !/token|jwt|secret|private_key|code/i.test(blob));

// --- 4. refresh persistence (re-read through the API, as a refreshed browser would)
const afterReload = await call('GET', `/v1/projects/${project.id}/sources`);
const listed = (afterReload.body.data ?? []).find((x) => x.id === srcId);
mark('4 source is read back from the backend after refresh', afterReload.status === 200 && !!listed);
mark('4 github source exposes its repository reference (not raw content)', listed?.sourceType === 'github' && listed?.externalReference?.externalItemId === String(target.itemId ?? target.id));

// --- 5. project isolation (canonical ProjectBoundary)
const other = (await admin.from('projects').insert({ name: 'K7 Isolation Project' }).select('id')).data[0];
const uid = (await admin.auth.admin.listUsers()).data.users.find((u) => u.email === EMAIL).id;
await admin.from('project_memberships').insert({ project_id: other.id, actor_subject: uid, role: 'owner' });

const bConn = await call('GET', `/v1/projects/${other.id}/connections`);
mark('5 project B sees no GitHub connection', bConn.status === 200 && (bConn.body.data ?? []).length === 0);
const bRepos = await call('GET', `/v1/projects/${other.id}/connections/github/repositories`);
mark('5 project B cannot list GitHub repositories', bRepos.status === 400 || bRepos.status === 403 || bRepos.status === 404);
const bRead = await call('GET', `/v1/projects/${other.id}/sources/${srcId}`);
mark('5 project B cannot read project A GitHub source', bRead.status === 404 || bRead.status === 403);
const bArchive = await call('DELETE', `/v1/projects/${other.id}/sources/${srcId}`);
mark('5 project B cannot archive project A GitHub source', bArchive.status === 404 || bArchive.status === 403);
const aStill = (await admin.from('sources').select('status').eq('id', srcId).maybeSingle()).data;
mark('5 project A source untouched by project B attempts', aStill?.status === 'registered');

// --- 7. disconnect semantics (KIP-side only; must NOT uninstall on GitHub)
const disc = await call('DELETE', `/v1/projects/${project.id}/connections/github`);
mark('7 disconnect returns 200 and reports not_connected', disc.status === 200 && disc.body.data?.status === 'not_connected');

const afterDisc = (await admin.from('external_connections').select('status, external_account_id, secure_secret_reference').eq('project_id', project.id).eq('provider', 'github').maybeSingle()).data;
mark('7 KIP connection marked disconnected, no secret left', afterDisc?.status === 'not_connected' && afterDisc?.secure_secret_reference === null);

const srcAfter = (await admin.from('sources').select('id, source_type, title, status').eq('id', srcId).maybeSingle()).data;
mark('7 historical source identity preserved (not deleted, not archived)', srcAfter?.id === srcId && srcAfter?.status === 'registered');

const refAfter = (await admin.from('external_source_references').select('external_item_id, display_name').eq('source_id', srcId).maybeSingle()).data;
mark('7 external reference preserved after disconnect', refAfter?.external_item_id === String(target.itemId ?? target.id) && refAfter?.display_name === target.name);

const reposWhenDisc = await call('GET', `/v1/projects/${project.id}/connections/github/repositories`);
mark('7 repository listing refuses while disconnected', reposWhenDisc.status === 400 || reposWhenDisc.status === 403 || reposWhenDisc.status === 404);

// restore the KIP-side binding so the dev connection stays usable (installation still real on GitHub)
await admin.from('external_connections').update({
  status: 'connected',
  external_account_id: conn.external_account_id,
  external_account_label: conn.external_account_label,
  updated_at: new Date().toISOString(),
}).eq('project_id', project.id).eq('provider', 'github');
const restoredRepos = await call('GET', `/v1/projects/${project.id}/connections/github/repositories`);
mark('7 connection restored and usable again (real repos listing)', restoredRepos.status === 200 && (restoredRepos.body.data ?? []).length > 0);

// --- 6. token/secret security across rows
const tokensInRows = JSON.stringify({
  conn: (await admin.from('external_connections').select('*').eq('project_id', project.id)).data,
  src: (await admin.from('sources').select('*').eq('project_id', project.id)).data,
  refs: (await admin.from('external_source_references').select('*').eq('project_id', project.id)).data,
  artifacts: (await admin.from('raw_artifacts').select('*').eq('project_id', project.id)).data,
});
mark('6 no installation token / App JWT / secret in any DB row', !/ghs_|eyJ[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY|client_secret/.test(tokensInRows));

// --- cleanup: isolation project only (the registered GitHub source is intentional dev data)
await admin.from('project_memberships').delete().eq('project_id', other.id);
await admin.from('projects').delete().eq('id', other.id);
mark('CLEANUP isolation project removed', ((await admin.from('projects').select('id').eq('name', 'K7 Isolation Project')).data ?? []).length === 0);

console.log(results.join('\n'));
console.log('ALL_PASS ' + results.every((r) => r.startsWith('PASS')));
