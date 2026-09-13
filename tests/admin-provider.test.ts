import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderStorage, maskKey } from '../src/platform/provider/provider.storage.ts';
import type { ProviderStorage, ProviderConfigRecord } from '../src/platform/provider/provider.storage.ts';
import {
  connectProvider,
  listProviders,
  revokeProvider,
  testConnection,
} from '../src/platform/api/admin-provider.ts';
import type { AdminProviderApiDeps } from '../src/platform/api/admin-provider.ts';
import type { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';

function fakeStorage(initial: ProviderConfigRecord[] = []): ProviderStorage {
  const rows = [...initial];
  let secret: string | null = null;
  const storage = {
    setSecret(v: string) {
      secret = v;
    },
    getSecret() {
      return secret;
    },
    async getProvider(key) {
      return rows.find((r) => r.providerKey === key) ?? null;
    },
    async listProviders() {
      return [...rows];
    },
    async saveProviderSecret(key, value, displayName) {
      const rec: ProviderConfigRecord = {
        id: 'cfg-1',
        providerKey: key,
        connectionStatus: 'connected',
        credentialConfigured: true,
        maskedKey: maskKey(value),
      };
      rows.length = 0;
      rows.push(rec);
      secret = value;
      return rec;
    },
    async readSecret() {
      return secret;
    },
    async setConnectionStatus(key, status, lastTestedAt) {
      const r = rows.find((x) => x.providerKey === key);
      if (r) {
        r.connectionStatus = status;
        r.lastTestedAt = lastTestedAt;
      }
    },
    async revokeCredential(key) {
      secret = null;
      const r = rows.find((x) => x.providerKey === key);
      if (r) {
        r.connectionStatus = 'not_configured';
        r.credentialConfigured = false;
        r.maskedKey = undefined;
      }
    },
  } as ProviderStorage;
  return storage;
}

function fakeGateway(validate: boolean, models = 12): Pick<OpenRouterGateway, 'validateKey' | 'listModels' | 'setApiKey'> {
  return {
    setApiKey() {
      /* no-op */
    },
    async validateKey() {
      return validate;
    },
    async listModels() {
      return Array.from({ length: models }, (_, i) => ({ id: `model-${i}` }));
    },
  };
}

test('maskKey never returns the full secret', () => {
  const key = 'sk-or-real-key-abcdefgh';
  const masked = maskKey(key);
  assert.ok(!masked.includes('real-key'));
  assert.ok(masked.includes('••••'));
  assert.equal(masked.length < key.length, true);
});

test('connectProvider stores secret and returns masked metadata (no secret)', async () => {
  const storage = fakeStorage();
  const deps: AdminProviderApiDeps = { storage, openRouter: fakeGateway(true) as unknown as OpenRouterGateway };
  const res = await connectProvider(deps, 'openrouter', { apiKey: 'sk-or-abcdef123456', displayName: 'OpenRouter' });
  assert.equal(res.ok, true);
  const data = (res as { data: unknown }).data as { maskedKey?: string; connectionStatus: string };
  assert.equal(data.connectionStatus, 'connected');
  assert.ok(data.maskedKey?.includes('••••'));
  assert.ok(!JSON.stringify(data).includes('abcdef123456'));
});

test('connectProvider rejects when provider rejects credential', async () => {
  const storage = fakeStorage();
  const deps: AdminProviderApiDeps = { storage, openRouter: fakeGateway(false) as unknown as OpenRouterGateway };
  const res = await connectProvider(deps, 'openrouter', { apiKey: 'sk-or-invalid-key' });
  assert.equal(res.ok, false);
  assert.equal((res as { error: { category: string } }).error.category, 'provider');
});

test('testConnection updates status from validation result', async () => {
  const storage = fakeStorage([{ id: 'x', providerKey: 'openrouter', connectionStatus: 'connected', credentialConfigured: true }]);
  (storage as unknown as { setSecret(v: string): void }).setSecret('«redacted:sk-…»');
  const deps: AdminProviderApiDeps = { storage, openRouter: fakeGateway(false) as unknown as OpenRouterGateway };
  const res = await testConnection(deps, 'openrouter');
  assert.equal(res.ok, true);
  assert.equal((res as { data: { status: string } }).data.status, 'failed');
  assert.equal((await storage.getProvider('openrouter'))!.connectionStatus, 'failed');
});

test('testConnection fails with validation when no secret stored', async () => {
  const storage = fakeStorage([{ id: 'x', providerKey: 'openrouter', connectionStatus: 'connected', credentialConfigured: false }]);
  const deps: AdminProviderApiDeps = { storage, openRouter: fakeGateway(true) as unknown as OpenRouterGateway };
  const res = await testConnection(deps, 'openrouter');
  assert.equal(res.ok, false);
  assert.equal((res as { error: { category: string } }).error.category, 'validation');
});

test('listProviders returns only public fields (masked, never full secret)', async () => {
  const storage = fakeStorage([
    { id: 'x', providerKey: 'openrouter', connectionStatus: 'connected', credentialConfigured: true, maskedKey: 'sk-or-••••abcd', lastTestedAt: '2026-01-01' },
  ]);
  const deps: AdminProviderApiDeps = { storage, openRouter: fakeGateway(true) as unknown as OpenRouterGateway };
  const res = await listProviders(deps);
  const data = (res as { data: unknown[] }).data as Record<string, unknown>[];
  const body = JSON.stringify(data);
  assert.ok(!('secret' in data[0]));
  assert.ok(!body.includes('abcdef123456'));
  assert.equal(data[0].credentialConfigured, true);
});

test('revokeProvider clears credential state', async () => {
  const storage = fakeStorage([{ id: 'x', providerKey: 'openrouter', connectionStatus: 'connected', credentialConfigured: true }]);
  const deps: AdminProviderApiDeps = { storage, openRouter: fakeGateway(true) as unknown as OpenRouterGateway };
  const res = await revokeProvider(deps, 'openrouter');
  assert.equal(res.ok, true);
  const cfg = await storage.getProvider('openrouter');
  assert.equal(cfg!.connectionStatus, 'not_configured');
  assert.equal(cfg!.credentialConfigured, false);
  assert.equal((storage as unknown as { getSecret(): string | null }).getSecret(), null);
});

test('createProviderStorage exposes readSecret/revoke contract (happy path fake)', async () => {
  const store = createProviderStorage({
    rpc: async (fn: string) => {
      if (fn === 'kip_vault_read_secret') return { data: 'sk-or-secret-value', error: null };
      return { data: null, error: null };
    },
    from: () => {
      return {
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
    },
  } as never);
  const secret = await store.readSecret('openrouter');
  assert.equal(secret, 'sk-or-secret-value');
});