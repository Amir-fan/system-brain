/**
 * Frontend client for the KIP model-assignment control-plane API.
 */
import type { WorkloadKey } from '../contracts/models';
import { call } from './transport';

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
  provider?: string;
  context_length?: number;
  pricing?: { prompt?: number | string; completion?: number | string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return call<T>(`${BASE}${path}`, init);
}

export async function listModelAssignments(): Promise<AdminAssignment[]> {
  return request('');
}

export async function putModelAssignment(workloadKey: WorkloadKey, modelId: string): Promise<AdminAssignment> {
  return request(`/${workloadKey}`, { method: 'PUT', body: JSON.stringify({ modelId }) });
}

export async function deleteModelAssignment(workloadKey: WorkloadKey): Promise<{ assigned: boolean }> {
  return request(`/${workloadKey}`, { method: 'DELETE' });
}

/** Live OpenRouter catalog normalized for the UI. */
export async function fetchModelCatalog(): Promise<{ count: number; models: CatalogModel[] }> {
  return call<{ count: number; models: CatalogModel[] }>('/v1/admin/providers/openrouter/models');
}