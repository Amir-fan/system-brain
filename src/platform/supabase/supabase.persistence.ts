/**
 * @kip
 * @module runtime
 * @layer platform
 * @owner platform-infra
 * @feature K0-002
 * @purpose Supabase persistence adapter implementing the runtime ports.
 */

import type { Actor, ProjectMembership, Role } from '../../core/authorization/actor.ts';
import type { Project } from '../../core/project/project.ts';
import type {
  RuntimePersistence,
  RunRecord,
} from '../../core/runtime/runtime.ports.ts';

/**
 * Platform boundary: this heavyweight type stays here, never in Core.
 *
 * A write/read chain is both chainable and awaitable; awaiting yields the PostgREST result.
 * PostgREST reports failures in `error` WITHOUT throwing, so the result MUST be inspected
 * — never discarded.
 */
export type SupabaseWrite = SupabaseDatabase &
  PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;

export type SupabaseDatabase = {
  from(table: string): SupabaseDatabase;
  select(columns: string): SupabaseDatabase;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): SupabaseWrite;
  update(values: Record<string, unknown>): SupabaseWrite;
  delete(): SupabaseDatabase;
  eq(column: string, value: unknown): SupabaseWrite;
  neq(column: string, value: unknown): SupabaseWrite;
  in(column: string, values: unknown[]): SupabaseWrite;
  order(column: string, opts?: { ascending?: boolean }): SupabaseDatabase;
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

    /**
     * Trusted provisioning primitive: idempotently ensure a membership exists.
     * NEVER downgrades — an existing row (any role) is returned unchanged; only a
     * missing membership is created with the requested role. The caller is
     * responsible for authorization (trusted proxy + manage on the project).
     */
    async ensureMembership(projectId: string, actor: Actor, role: Role): Promise<ProjectMembership> {
      const existing = await this.getMembership(projectId, actor);
      if (existing) return existing;
      const { error } = await db.from('project_memberships').insert({
        project_id: projectId,
        actor_subject: actor,
        role,
      });
      if (error) {
        // Idempotency under a concurrent insert: a uniqueness violation means the
        // row now exists — re-read it instead of failing the provisioning turn.
        const now = await this.getMembership(projectId, actor);
        if (now) return now;
        throw new Error(`membership provision failed: ${(error as { code?: string }).code ?? ''} ${(error as { message?: string }).message ?? ''}`.trim());
      }
      const created = await this.getMembership(projectId, actor);
      if (!created) throw new Error('membership provision failed: not readable after insert');
      return created;
    },

    async createRun(record) {
      const { error } = await db.from('runs').insert({
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
      // A run that cannot be opened must not look opened; surface it instead of
      // continuing with a run the store does not know about.
      if (error) throw new Error(`run insert failed: ${error.code ?? ''} ${error.message}`.trim());
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
      // PostgREST reports write failures in `error` WITHOUT throwing. Swallowing it
      // left runs permanently `started` and made real failures undiagnosable, so the
      // runtime is told explicitly whether finalization succeeded.
      const { error } = await db.from('runs').update(dbPatch).eq('id', id);
      if (error) throw new Error(`run update failed: ${error.code ?? ''} ${error.message}`.trim());
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