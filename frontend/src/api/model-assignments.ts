/**
 * Frontend client for the KIP model-assignment control-plane API.
 */
import type { WorkloadKey } from '../contracts/models';

const BASE = '/v1/admin/model-assignments';

export interface AdminAssignment {
  workloadKey: WorkloadKey;
  providerKey: string;
  modelId: string;
  isActive: boolean;
}

export interface CatalogModel {
  id: string;
  name: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as unknown;
  if (!res.ok) throw new Error(((body as { error?: { message?: string } }).error?.message) ?? 'request failed');
  return (body as { data: T }).data;
}

export async function listModelAssignments(): Promise<AdminAssignment[]> {
  return request('/');
}

export async function putModelAssignment(workloadKey: WorkloadKey, modelId: string): Promise<AdminAssignment> {
  return request(`/${workloadKey}`, { method: 'PUT', body: JSON.stringify({ modelId }) });
}

export async function deleteModelAssignment(workloadKey: WorkloadKey): Promise<{ assigned: boolean }> {
  return request(`/${workloadKey}`, { method: 'DELETE' });
}

/** Live OpenRouter catalog normalized for the UI. */
export async function fetchModelCatalog(): Promise<{ count: number; models: CatalogModel[] }> {
  const res = await fetch('/v1/admin/providers/openrouter/models', {
    headers: { 'content-type': 'application/json' },
  });
  const body = (await res.json()) as unknown;
  if (!res.ok) throw new Error(((body as { error?: { message?: string } }).error?.message) ?? 'catalog request failed');
  return (body as { data: { count: number; models: CatalogModel[] } }).data;
}