/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-006
 * @purpose Model assignment persistence + resolver (platform control-plane).
 *
 * The provider adapter must NOT know assignments, workloads, or policy. This is
 * the control-plane boundary that maps a canonical workload to a resolved model
 * BEFORE the gateway executes. Missing assignment => normalized error, no fallback.
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import type { ModelRequirement } from '../../core/model-gateway/model-gateway.ts';

export const ALLOWED_WORKLOADS = [
  'source_analysis',
  'chat_assistant',
  'vision_scan',
  'summarization',
  'embeddings',
  'knowledge_answer',
] as const;
export type WorkloadKey = (typeof ALLOWED_WORKLOADS)[number];

export interface ModelAssignment {
  workloadKey: WorkloadKey;
  providerKey: string;
  modelId: string;
  isActive: boolean;
}

export interface ResolvedModel {
  providerKey: string;
  modelId: string;
}

/** Thrown when no active assignment exists for a required workload. */
export class MissingAssignmentError extends Error {
  readonly workloadKey: string;
  constructor(workloadKey: string) {
    super(`no model assignment for workload '${workloadKey}'`);
    this.workloadKey = workloadKey;
    this.name = 'MissingAssignmentError';
  }
}

export interface ModelAssignmentStorage {
  get(workloadKey: WorkloadKey): Promise<ModelAssignment | null>;
  list(): Promise<ModelAssignment[]>;
  upsert(workloadKey: WorkloadKey, modelId: string, providerKey?: string): Promise<ModelAssignment>;
  remove(workloadKey: WorkloadKey): Promise<void>;
}

export function isWorkloadKey(k: string): k is WorkloadKey {
  return (ALLOWED_WORKLOADS as readonly string[]).includes(k);
}

export function createModelAssignmentStorage(db: SupabaseDatabase): ModelAssignmentStorage {
  const mapRow = (r: Record<string, unknown>): ModelAssignment => ({
    workloadKey: r.workload_key as WorkloadKey,
    providerKey: r.provider_key as string,
    modelId: r.model_id as string,
    isActive: r.is_active as boolean,
  });

  const getById = async (workloadKey: WorkloadKey) => {
    const { data } = await db
      .from('model_assignments')
      .select('workload_key, provider_key, model_id, is_active')
      .eq('workload_key', workloadKey)
      .maybeSingle();
    return data ? mapRow(data) : null;
  };

  return {
    async get(workloadKey) {
      return getById(workloadKey);
    },
    async list() {
      const { data } = await (db.from('model_assignments').select('workload_key, provider_key, model_id, is_active') as unknown as Promise<{
        data: Array<Record<string, unknown>> | null;
      }>);
      return (data ?? []).map(mapRow);
    },
    async upsert(workloadKey, modelId, providerKey = 'openrouter') {
      const existing = await getById(workloadKey);
      if (existing) {
        await db
          .from('model_assignments')
          .update({ model_id: modelId, provider_key: providerKey, is_active: true, updated_at: new Date().toISOString() })
          .eq('workload_key', workloadKey);
      } else {
        await db
          .from('model_assignments')
          .insert({ workload_key: workloadKey, provider_key: providerKey, model_id: modelId, is_active: true });
      }
      const fresh = await getById(workloadKey);
      if (!fresh) throw new Error('model assignment write failed');
      return fresh;
    },
    async remove(workloadKey) {
      await db.from('model_assignments').delete().eq('workload_key', workloadKey);
    },
  };
}

/**
 * Resolves a ModelRequirement (canonical workload) to { providerKey, modelId }.
 * No silent fallback: a missing/inactive assignment raises MissingAssignmentError.
 */
export interface ModelAssignmentResolver {
  resolve(requirement: ModelRequirement): Promise<ResolvedModel>;
}

export function createModelAssignmentResolver(storage: ModelAssignmentStorage): ModelAssignmentResolver {
  return {
    async resolve(requirement) {
      const workload = requirement.profile;
      if (!workload || !isWorkloadKey(workload)) {
        throw new MissingAssignmentError(workload ?? '');
      }
      const assignment = await storage.get(workload);
      if (!assignment || !assignment.isActive) {
        throw new MissingAssignmentError(workload);
      }
      if (assignment.providerKey !== 'openrouter') {
        throw new Error(`assignment provider '${assignment.providerKey}' not supported`);
      }
      return { providerKey: assignment.providerKey, modelId: assignment.modelId };
    },
  };
}