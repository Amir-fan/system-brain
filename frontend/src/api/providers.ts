/**
 * Slim frontend client for the KIP platform-admin provider API.
 * Returns only masked/status data — never the secret.
 */

export interface ProviderPublic {
  provider: string;
  connectionStatus: 'connected' | 'failed' | 'not_configured';
  credentialConfigured: boolean;
  maskedKey?: string;
  lastTestedAt?: string;
}

const BASE = '/v1/admin/providers';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as unknown;
  if (!res.ok) throw new Error(((body as { error?: { message?: string } }).error?.message) ?? 'request failed');
  return (body as { data: T }).data;
}

export async function connectOpenRouter(apiKey: string, displayName?: string): Promise<ProviderPublic> {
  return request('/openrouter', { method: 'POST', body: JSON.stringify({ apiKey, displayName }) });
}

export async function testOpenRouter(): Promise<{ status: 'connected' | 'failed' }> {
  return request('/openrouter/test', { method: 'POST' });
}

export async function listOpenRouter(): Promise<ProviderPublic> {
  return request('/openrouter');
}

export async function revokeOpenRouter(): Promise<{ provider: string; status: string }> {
  return request('/openrouter/revoke', { method: 'POST' });
}

export async function listOpenRouterModels(): Promise<{ count: number; models: Array<{ id: string }> }> {
  return request('/openrouter/models');
}