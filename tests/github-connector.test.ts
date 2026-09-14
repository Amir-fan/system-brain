import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createConnectionState, verifyConnectionState, STATE_TTL_SECONDS } from '../src/platform/github/connection-state.ts';
import { createAppJwt, isValidPrivateKey, createGitHubAppAuth } from '../src/platform/github/github-app.ts';
import {
  handleGitHubStart,
  handleGitHubCallback,
  handleGitHubRepositories,
  handleGitHubDisconnect,
} from '../src/platform/api/github-connector.ts';

const SECRET = 'test-state-secret-not-a-real-value';

test('connection state: round trip preserves project + actor', () => {
  const token = createConnectionState(SECRET, { projectId: 'p1', actor: 'a1' });
  const v = verifyConnectionState(SECRET, token);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.state.projectId, 'p1');
    assert.equal(v.state.actor, 'a1');
    assert.ok(v.state.nonce.length >= 16);
    assert.ok(v.state.exp > Math.floor(Date.now() / 1000));
  }
});

test('connection state: missing / malformed are refused', () => {
  assert.equal(verifyConnectionState(SECRET, undefined).ok, false);
  assert.equal(verifyConnectionState(SECRET, 'garbage').ok, false);
  assert.equal(verifyConnectionState(SECRET, 'a.b.c').ok, false);
});

test('connection state: tampered payload is refused', () => {
  const token = createConnectionState(SECRET, { projectId: 'p1', actor: 'a1' });
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ projectId: 'other', actor: 'a1', exp: 9999999999, nonce: 'x' })).toString('base64url');
  const v = verifyConnectionState(SECRET, forged + '.' + sig);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'tampered');
  assert.equal(verifyConnectionState('other-secret', token).ok, false);
  assert.equal(verifyConnectionState(SECRET, payload + '.AAAA').ok, false);
});

test('connection state: expired state is refused', () => {
  const past = Date.now() - (STATE_TTL_SECONDS + 60) * 1000;
  const token = createConnectionState(SECRET, { projectId: 'p1', actor: 'a1' }, past);
  const v = verifyConnectionState(SECRET, token);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, 'expired');
});

test('app JWT: RS256 header, app id issuer, at most 10 minute lifetime', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const now = 1700000000;
  const jwt = createAppJwt('123456', privateKey, now);
  const parts = jwt.split('.');
  assert.ok(parts[0] && parts[1] && parts[2], 'JWT has three segments');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.equal(header.alg, 'RS256');
  assert.equal(payload.iss, '123456');
  assert.equal(payload.exp - payload.iat, 600);
  assert.ok(payload.exp - now <= 600, 'never exceeds the 10 minute limit');
});

test('private key validation rejects non-key material', () => {
  assert.equal(isValidPrivateKey('not a key'), false);
  assert.equal(isValidPrivateKey(''), false);
});

function fakeBoundary(role: string | null) {
  return {
    getProject: async (id: string) => ({ id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' }),
    getMembership: async (projectId: string, actor: string) =>
      role ? { projectId, actor, role: role as 'owner', createdAt: '' } : null,
  };
}

function fakeConnections() {
  const saved: Array<{ projectId: string; accountId?: string; accountLabel?: string; secretRef?: string }> = [];
  const state: { current: Record<string, unknown> | null } = { current: null };
  const storage = {
    listConnections: async () => (state.current ? [state.current] : []),
    getConnection: async () => state.current,
    readSecret: async () => null,
    saveConnection: async (projectId: string, _p: string, input: { accountId?: string; accountLabel?: string; secretRef?: string }) => {
      saved.push({ projectId, ...input });
      state.current = { id: 'c1', projectId, provider: 'github', status: 'connected', accountId: input.accountId, accountLabel: input.accountLabel };
      return state.current;
    },
    disconnect: async () => {
      state.current = null;
    },
    createReference: async () => ({}),
    listReferencesByProject: async () => [],
    getReferenceBySource: async () => null,
  };
  return { saved, state, storage };
}

const fakeApp = (overrides: Record<string, unknown> = {}) => ({
  installationToken: async () => 'installation-token',
  installation: async (id: string) => ({ id, accountLogin: 'acme', accountType: 'Organization' }),
  listInstallationRepositories: async () => [
    { id: '11', fullName: 'acme/repo-a', name: 'repo-a', url: 'https://github.com/acme/repo-a', defaultBranch: 'main', private: true },
  ],
  installUrl: (state: string) => 'https://github.com/apps/kip-knowledge/installations/new?state=' + encodeURIComponent(state),
  ...overrides,
});

const deps = (role: string | null, app: Record<string, unknown> = fakeApp(), conn = fakeConnections()) => ({
  app,
  stateSecret: SECRET,
  connections: conn.storage,
  boundary: fakeBoundary(role),
  frontendUrl: 'http://localhost:5173',
  conn,
});

test('start: owner gets an install URL carrying signed state; member is refused', async () => {
  const d = deps('owner');
  const res = await handleGitHubStart(d as never, 'p1', 'a1');
  assert.equal(res.ok, true);
  if (res.ok) {
    const url = (res.data as { url: string }).url;
    assert.ok(url.startsWith('https://github.com/apps/kip-knowledge/installations/new?state='));
    const v = verifyConnectionState(SECRET, decodeURIComponent(url.split('state=')[1]));
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.state.projectId, 'p1');
  }
  const denied = await handleGitHubStart(deps('member') as never, 'p1', 'a1');
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
});

test('callback: missing or tampered state never binds an installation', async () => {
  const d = deps('owner');
  for (const qs of ['', 'state=bogus', 'installation_id=5']) {
    const out = await handleGitHubCallback(d as never, new URLSearchParams(qs));
    assert.equal(out.redirect, 'http://localhost:5173/knowledge?github=error');
  }
  assert.equal(d.conn.saved.length, 0, 'nothing persisted on invalid state');
});

test('callback: valid state binds the installation and stores no secret', async () => {
  const d = deps('owner');
  const state = createConnectionState(SECRET, { projectId: 'p1', actor: 'a1' });
  const out = await handleGitHubCallback(d as never, new URLSearchParams({ state, installation_id: '99', setup_action: 'install' }));
  assert.equal(out.redirect, 'http://localhost:5173/knowledge?github=connected');
  assert.equal(d.conn.saved.length, 1);
  assert.equal(d.conn.saved[0].accountId, '99');
  assert.equal(d.conn.saved[0].accountLabel, 'acme');
  assert.equal(d.conn.saved[0].secretRef, undefined, 'installation tokens are never stored');
});

test('callback: state for a project the actor no longer belongs to is refused', async () => {
  const d = deps(null);
  const state = createConnectionState(SECRET, { projectId: 'p1', actor: 'a1' });
  const out = await handleGitHubCallback(d as never, new URLSearchParams({ state, installation_id: '99' }));
  assert.equal(out.redirect, 'http://localhost:5173/knowledge?github=error');
  assert.equal(d.conn.saved.length, 0);
});

test('callback: provider failure yields a generic indicator only', async () => {
  const app = fakeApp({ installation: async () => { throw new Error('boom'); } });
  const d = deps('owner', app);
  const state = createConnectionState(SECRET, { projectId: 'p1', actor: 'a1' });
  const out = await handleGitHubCallback(d as never, new URLSearchParams({ state, installation_id: '99' }));
  assert.equal(out.redirect, 'http://localhost:5173/knowledge?github=error');
  assert.ok(!out.redirect.includes('boom'), 'raw provider error is never echoed');
});

test('repositories: not connected returns a validation error, never a fabricated list', async () => {
  const res = await handleGitHubRepositories(deps('owner') as never, 'p1', 'a1');
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('repositories: connected returns real installation-scoped repositories', async () => {
  const d = deps('owner');
  await (d.conn.storage.saveConnection as never as (a: string, b: string, c: unknown) => Promise<unknown>)('p1', 'github', { accountId: '99', accountLabel: 'acme' });
  const res = await handleGitHubRepositories(d as never, 'p1', 'a1');
  assert.equal(res.ok, true);
  const rows = (res.ok ? res.data : []) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '11');
  assert.equal(rows[0].name, 'acme/repo-a');
  assert.equal(rows[0].type, 'repository');
  assert.equal(rows[0].detail, 'main');
  assert.equal(rows[0].visibility, 'private');
});

test('repositories: cross-project access is denied by the boundary', async () => {
  const res = await handleGitHubRepositories(deps(null) as never, 'p1', 'a1');
  assert.equal(res.ok, false);
  assert.ok(res.status === 403 || res.status === 404);
});

test('disconnect revokes access without deleting source identity', async () => {
  const d = deps('owner');
  await (d.conn.storage.saveConnection as never as (a: string, b: string, c: unknown) => Promise<unknown>)('p1', 'github', { accountId: '99', accountLabel: 'acme' });
  const res = await handleGitHubDisconnect(d as never, 'p1', 'a1');
  assert.equal(res.ok, true);
  assert.equal(d.conn.state.current, null, 'connection is cleared');
});

test('app auth: installation token is cached in memory', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ token: 'tok-1', expires_at: new Date(Date.now() + 3600000).toISOString() }) };
  }) as unknown as typeof fetch;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const auth = createGitHubAppAuth(
    { appId: '1', clientSecret: 's', privateKeyPem: privateKey, slug: 'x', publicApiUrl: 'http://x' },
    fetchImpl,
  );
  assert.equal(await auth.installationToken('99'), 'tok-1');
  assert.equal(await auth.installationToken('99'), 'tok-1');
  assert.equal(calls.length, 1, 'token reused from memory until near expiry');
});
