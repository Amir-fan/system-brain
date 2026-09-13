/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K0-005
 * @purpose Platform-admin provider API (connect / list / test / revoke / models).
 *
 * Platform-level provider management. Auth: temporary bootstrap admin token
 * (constant-time check). Secrets are stored in Supabase Vault; only masked
 * metadata is ever returned. No project scoping, no BYOK.
 */

import type { ProviderStorage } from '../provider/provider.storage.ts';
import type { OpenRouterGateway } from '../model-gateway/openrouter.gateway.ts';
import { providerError } from '../../core/model-gateway/gateway-errors.ts';

export interface AdminProviderApiDeps {
  storage: ProviderStorage;
  openRouter: OpenRouterGateway;
}

export type AdminApiResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; category: string } };

function ok(data: unknown): AdminApiResponse {
  return { ok: true, data };
}
function fail(message: string, category = 'runtime'): AdminApiResponse {
  return { ok: false, error: { message, category } };
}

export async function connectProvider(
  deps: AdminProviderApiDeps,
  providerKey: string,
  body: unknown,
): Promise<AdminApiResponse> {
  const { apiKey, displayName } = (body ?? {}) as { apiKey?: string; displayName?: string };
  if (providerKey !== 'openrouter') return fail('unknown provider', 'validation');
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 8) {
    return fail('a valid apiKey is required', 'validation');
  }
  try {
    const probe = await deps.openRouter.validateKey();
    if (!probe) return fail('provider rejected the credential', 'provider');

    const config = await deps.storage.saveProviderSecret(providerKey, apiKey, displayName);
    return ok(publicConfig(config));
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'connection failed', 'provider');
  }
}

export async function testConnection(deps: AdminProviderApiDeps, providerKey: string): Promise<AdminApiResponse> {
  if (providerKey !== 'openrouter') return fail('unknown provider', 'validation');
  try {
    const secret = await deps.storage.readSecret(providerKey);
    if (!secret) {
      await deps.storage.setConnectionStatus(providerKey, 'not_configured');
      return fail('provider has no stored credential', 'validation');
    }
    deps.openRouter.setApiKey(secret);
    const valid = await deps.openRouter.validateKey();
    await deps.storage.setConnectionStatus(providerKey, valid ? 'connected' : 'failed', new Date().toISOString());
    return ok({ status: valid ? 'connected' : 'failed' });
  } catch (e) {
    await deps.storage.setConnectionStatus(providerKey, 'failed', new Date().toISOString());
    return fail(e instanceof Error ? e.message : 'test failed', 'provider');
  }
}

export async function listProviders(deps: AdminProviderApiDeps): Promise<AdminApiResponse> {
  const configs = await deps.storage.listProviders();
  return ok(configs.map(publicConfig));
}

export async function revokeProvider(deps: AdminProviderApiDeps, providerKey: string): Promise<AdminApiResponse> {
  if (providerKey !== 'openrouter') return fail('unknown provider', 'validation');
  try {
    await deps.storage.revokeCredential(providerKey);
    return ok({ provider: providerKey, status: 'not_configured' });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'revoke failed', 'runtime');
  }
}

export async function listProviderModels(deps: AdminProviderApiDeps): Promise<AdminApiResponse> {
  try {
    const secret = await deps.storage.readSecret('openrouter');
    if (secret) deps.openRouter.setApiKey(secret);
    const models = await deps.openRouter.listModels();
    return ok({ count: models.length, models: models.slice(0, 100) });
  } catch {
    return fail('models request failed', 'provider');
  }
}

/** Never return the secret — only masked metadata + status. */
function publicConfig(c: Awaited<ReturnType<ProviderStorage['getProvider']>> & object): unknown {
  if (!c) return null;
  return {
    provider: (c as { providerKey: string }).providerKey,
    connectionStatus: (c as { connectionStatus: string }).connectionStatus,
    credentialConfigured: (c as { credentialConfigured: boolean }).credentialConfigured,
    maskedKey: (c as { maskedKey?: string }).maskedKey ?? undefined,
    lastTestedAt: (c as { lastTestedAt?: string }).lastTestedAt ?? undefined,
  };
}

export type { ProviderConfigRecord } from '../provider/provider.storage.ts';
export { providerError };