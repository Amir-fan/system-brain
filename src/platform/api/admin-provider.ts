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
import type {
  ModelAssignmentStorage,
  ModelAssignmentResolver,
} from '../provider/model-assignment.ts';
import { isWorkloadKey, ALLOWED_WORKLOADS } from '../provider/model-assignment.ts';
import {
  EMBEDDING_MODEL_CATALOG,
  LOCKED_EMBEDDING_DIMENSIONS,
  assignableEmbeddingModels,
  isAssignableEmbeddingModel,
} from '../model-gateway/embedding-models.catalog.ts';
import type { ModelGatewayOutput } from '../../core/model-gateway/model-gateway.ts';
import { providerError } from '../../core/model-gateway/gateway-errors.ts';

export interface AdminProviderApiDeps {
  storage: ProviderStorage;
  openRouter: OpenRouterGateway;
  assignmentStorage?: ModelAssignmentStorage;
  resolver?: ModelAssignmentResolver;
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
    // Validate the incoming credential with the gateway BEFORE storing it.
    deps.openRouter.setApiKey(apiKey);
    const probe = await deps.openRouter.validateKey();
    if (!probe) return fail('provider rejected the credential', 'provider');

    const config = await deps.storage.saveProviderSecret(providerKey, apiKey, displayName);
    // Restore the stored (rotated) credential as the gateway's active key.
    deps.openRouter.setApiKey(apiKey);
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

/**
 * Embedding-capable models. A DISTINCT catalog from the chat models: OpenRouter's
 * GET /models does not list embedding models at all, so folding them together
 * would advertise models that cannot answer a chat request. Capabilities come
 * from the curated catalog, which also keeps the picker honest about the locked
 * vector width.
 */
export async function getEmbeddingModelCatalog(_deps: AdminProviderApiDeps): Promise<AdminApiResponse> {
  return ok({
    lockedDimensions: LOCKED_EMBEDDING_DIMENSIONS,
    count: EMBEDDING_MODEL_CATALOG.length,
    assignableCount: assignableEmbeddingModels().length,
    models: EMBEDDING_MODEL_CATALOG.map((m) => ({
      id: m.id,
      providerKey: m.providerKey,
      label: m.label,
      nativeDimensions: m.nativeDimensions,
      supportedDimensions: m.supportedDimensions,
      contextTokens: m.contextTokens,
      pricePerMillionTokensUsd: m.pricePerMillionTokensUsd,
      multilingual: m.multilingual,
      approved: m.approved,
      // Only models that can emit the locked width may be assigned in V1.
      assignable: m.supportedDimensions.includes(LOCKED_EMBEDDING_DIMENSIONS),
      notes: m.notes,
    })),
  });
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

/** Live OpenRouter catalog normalized for the UI (never persisted; no secrets). */
export async function getModelCatalog(deps: AdminProviderApiDeps): Promise<AdminApiResponse> {
  try {
    const secret = await deps.storage.readSecret('openrouter');
    if (secret) deps.openRouter.setApiKey(secret);
    const models = await deps.openRouter.listModels();
    return ok({ count: models.length, models: normalizeCatalog(models) });
  } catch {
    return fail('models request failed', 'provider');
  }
}

function normalizeCatalog(raw: Array<{ id: string; name?: string; context_length?: number; pricing?: Record<string, unknown> }>): Array<Record<string, unknown>> {
  return raw.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
  }));
}

// ---------------------------------------------------------------------------
// Model Assignment admin endpoints (control-plane, platform-level)
// ---------------------------------------------------------------------------

export async function listAssignments(deps: AdminProviderApiDeps): Promise<AdminApiResponse> {
  if (!deps.assignmentStorage) return fail('assignment storage not configured', 'runtime');
  const assignments = await deps.assignmentStorage.list();
  return ok(assignments.map((a) => ({
    workloadKey: a.workloadKey,
    providerKey: a.providerKey,
    modelId: a.modelId,
    isActive: a.isActive,
  })));
}

export async function putAssignment(
  deps: AdminProviderApiDeps,
  workloadKey: string,
  body: unknown,
): Promise<AdminApiResponse> {
  if (!deps.assignmentStorage) return fail('assignment storage not configured', 'runtime');
  if (!isWorkloadKey(workloadKey)) return fail(`invalid workload '${workloadKey}'`, 'validation');
  const { modelId } = (body ?? {}) as { modelId?: string };
  if (!modelId || typeof modelId !== 'string') return fail('modelId is required', 'validation');

  // K14: embedding models live in a DISTINCT catalog — OpenRouter's chat catalog
  // never lists them — and only a model that can emit the locked vector width may
  // be assigned, because the pgvector column is fixed-width.
  if (workloadKey === 'embeddings') {
    if (!isAssignableEmbeddingModel(modelId)) {
      return fail(
        `model '${modelId}' cannot emit the locked ${LOCKED_EMBEDDING_DIMENSIONS}-dimension vector`,
        'validation',
      );
    }
  } else {
    // Validate the selected chat model against the live OpenRouter catalog.
    const catalogRes = await getModelCatalog(deps);
    if (!catalogRes.ok) return catalogRes;
    const catalog = (catalogRes.data as { models: Array<{ id: string }> }).models;
    if (!catalog.some((m) => m.id === modelId)) {
      return fail(`model '${modelId}' is not in the OpenRouter catalog`, 'validation');
    }
  }

  const assignment = await deps.assignmentStorage.upsert(workloadKey as never, modelId, 'openrouter');
  return ok({ workloadKey: assignment.workloadKey, providerKey: assignment.providerKey, modelId: assignment.modelId, isActive: assignment.isActive });
}

export async function deleteAssignment(deps: AdminProviderApiDeps, workloadKey: string): Promise<AdminApiResponse> {
  if (!deps.assignmentStorage) return fail('assignment storage not configured', 'runtime');
  if (!isWorkloadKey(workloadKey)) return fail(`invalid workload '${workloadKey}'`, 'validation');
  await deps.assignmentStorage.remove(workloadKey); // revert to unassigned (no default model)
  return ok({ workloadKey, assigned: false });
}

export { ALLOWED_WORKLOADS };

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