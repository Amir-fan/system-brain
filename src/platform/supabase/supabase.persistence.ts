/**
 * @kip
 * @module runtime
 * @layer platform
 * @owner platform-infra
 * @feature K0-002
 * @purpose Supabase persistence adapter implementing the runtime ports.
 */

import type { Actor, ProjectMembership } from '../../core/authorization/actor.ts';
import type { Project } from '../../core/project/project.ts';
import type {
  RuntimePersistence,
  RunRecord,
} from '../../core/runtime/runtime.ports.ts';

/** Platform boundary: this heavyweight type stays here, never in Core. */
export type SupabaseDatabase = {
  from(table: string): SupabaseDatabase;
  select(columns: string): SupabaseDatabase;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): SupabaseDatabase;
  update(values: Record<string, unknown>): SupabaseDatabase;
  delete(): SupabaseDatabase;
  eq(column: string, value: unknown): SupabaseDatabase;
  neq(column: string, value: unknown): SupabaseDatabase;
  limit(count: number): Promise<{ data: Array<Record<string, unknown>> | null; error: unknown }>;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
};

export interface SupabasePersistenceOptions {
  url: string;
  /** Modern server-only secret key (e.g. Supabase secret key / legacy service_role). Never logged. */
  serverKey: string;
}

export function createSupabaseRuntimePersistence(db: SupabaseDatabase): RuntimePersistence {
  return {
    async getProject(projectId) {
      const { data } = await db
        .from('projects')
        .select('id, name, status, created_at, updated_at')
        .eq('id', projectId)
        .maybeSingle();
      return data ? mapProject(data) : null;
    },

    async getMembership(projectId, actor) {
      const { data } = await db
        .from('project_memberships')
        .select('project_id, actor_subject, role, created_at')
        .eq('project_id', projectId)
        .eq('actor_subject', actor)
        .maybeSingle();
      return data
        ? {
            projectId: data.project_id as string,
            actor: data.actor_subject as string,
            role: data.role as ProjectMembership['role'],
            createdAt: data.created_at as string,
          }
        : null;
    },

    async createRun(record) {
      await db.from('runs').insert({
        id: record.id,
        project_id: record.projectId,
        actor_subject: record.actorSubject ?? null,
        capability_key: record.capability,
        status: record.status,
        started_at: record.startedAt,
        completed_at: record.completedAt ?? null,
        latency_ms: record.latencyMs ?? null,
        error_category: record.errorCategory ?? null,
      });
    },

    async updateRun(id, patch) {
      const dbPatch: Record<string, unknown> = {};
      if (patch.status !== undefined) dbPatch.status = patch.status;
      if (patch.completedAt !== undefined) dbPatch.completed_at = patch.completedAt;
      if (patch.latencyMs !== undefined) dbPatch.latency_ms = patch.latencyMs;
      if (patch.errorCategory !== undefined) dbPatch.error_category = patch.errorCategory;
      if (patch.providerKey !== undefined) dbPatch.provider_key = patch.providerKey;
      if (patch.modelName !== undefined) dbPatch.model_name = patch.modelName;
      if (patch.usage) {
        if (patch.usage.promptTokens !== undefined) dbPatch.usage_tokens_prompt = patch.usage.promptTokens;
        if (patch.usage.completionTokens !== undefined) dbPatch.usage_tokens_completion = patch.usage.completionTokens;
        if (patch.usage.totalTokens !== undefined) dbPatch.usage_tokens_total = patch.usage.totalTokens;
        if (patch.usage.costUsd !== undefined) dbPatch.usage_cost_usd = patch.usage.costUsd;
      }
      await db.from('runs').update(dbPatch).eq('id', id);
    },
  };
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as Project['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}