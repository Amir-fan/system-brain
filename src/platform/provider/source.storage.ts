/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-007
 * @purpose Source Registry persistence (project-scoped knowledge sources).
 *
 * Source = canonical identity + lifecycle record, NOT document content.
 * V1 implemented type: url. Status owned by the registry only via the single
 * registered -> archived transition; ingestion transitions belong to a future slice.
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';

// Canonical vocabulary lives in the project/source domain (single definition);
// re-exported here so existing importers keep working.
import { SOURCE_TYPES, isSourceType } from '../../core/project/source-type.ts';
import type { SourceType } from '../../core/project/source-type.ts';
export { SOURCE_TYPES, isSourceType };
export type { SourceType };

/** Types whose origin is an external connection (registered, never stored locally). */
export const CONNECTED_SOURCE_TYPES = ['github', 'google_drive'] as const;

export const SOURCE_STATUSES = ['registered', 'archived'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Source Role V1: retrieval-policy metadata only (never truth/authority/permission). */
export const SOURCE_ROLES = ['primary', 'supporting', 'reference'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];
export const DEFAULT_SOURCE_ROLE: SourceRole = 'supporting';
export function isSourceRole(v: unknown): v is SourceRole {
  return typeof v === 'string' && (SOURCE_ROLES as readonly string[]).includes(v);
}

export interface SourceRecord {
  id: string;
  projectId: string;
  sourceType: SourceType;
  title: string;
  description?: string;
  externalUri?: string;
  status: SourceStatus;
  role: SourceRole;
  createdBySubject: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CreateSourceInput {
  /** Optional caller-supplied id so storage paths can be planned before insert. */
  id?: string;
  projectId: string;
  sourceType: SourceType;
  title: string;
  description?: string;
  externalUri?: string;
  role?: SourceRole;
  createdBySubject: string;
}

export interface UpdateSourceInput {
  title?: string;
  description?: string;
  externalUri?: string;
  role?: SourceRole;
}

export interface SourceStorage {
  create(input: CreateSourceInput): Promise<SourceRecord>;
  listByProject(projectId: string, includeArchived?: boolean): Promise<SourceRecord[]>;
  getByProject(projectId: string, sourceId: string): Promise<SourceRecord | null>;
  update(projectId: string, sourceId: string, patch: UpdateSourceInput): Promise<SourceRecord | null>;
  archive(projectId: string, sourceId: string): Promise<SourceRecord | null>;
  /** Compensation only: used to roll back a source whose raw artifact failed to persist. */
  hardDelete(projectId: string, sourceId: string): Promise<void>;
}

const mapRow = (r: Record<string, unknown>): SourceRecord => ({
  id: r.id as string,
  projectId: r.project_id as string,
  sourceType: r.source_type as SourceType,
  title: r.title as string,
  description: (r.description as string) ?? undefined,
  externalUri: (r.external_uri as string) ?? undefined,
  status: r.status as SourceStatus,
  role: (isSourceRole(r.role) ? r.role : DEFAULT_SOURCE_ROLE) as SourceRole,
  createdBySubject: r.created_by_subject as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  archivedAt: (r.archived_at as string) ?? undefined,
});

export function createSourceStorage(db: SupabaseDatabase): SourceStorage {
  const getById = async (projectId: string, sourceId: string) => {
    const { data } = await db
      .from('sources')
      .select('id, project_id, source_type, title, description, external_uri, status, role, created_by_subject, created_at, updated_at, archived_at')
      .eq('project_id', projectId)
      .eq('id', sourceId)
      .maybeSingle();
    return data ? mapRow(data) : null;
  };

  return {
    async create(input) {
      // Generate the id up-front (unless the caller planned one) so we can
      // deterministically read the created row and pre-plan storage paths.
      const id = input.id ?? crypto.randomUUID();
      const row = {
        id,
        project_id: input.projectId,
        source_type: input.sourceType,
        title: input.title,
        description: input.description ?? null,
        external_uri: input.externalUri ?? null,
        status: 'registered',
        role: input.role ?? DEFAULT_SOURCE_ROLE,
        created_by_subject: input.createdBySubject,
      };
      const { data, error } = await (db
        .from('sources')
        .insert(row)
        .select('id, project_id, source_type, title, description, external_uri, status, role, created_by_subject, created_at, updated_at, archived_at')
        .maybeSingle() as unknown as Promise<{ data: Record<string, unknown> | null; error: unknown }>);
      if (error || !data) throw new Error('source create failed');
      // Prefer reading the exact inserted row by id (deterministic regardless of what `.select()` returned).
      const fresh = await getById(input.projectId, id);
      return fresh ?? mapRow(data);
    },
    async listByProject(projectId, includeArchived = false) {
      let q = db.from('sources').select('id, project_id, source_type, title, description, external_uri, status, role, created_by_subject, created_at, updated_at, archived_at').eq('project_id', projectId);
      if (!includeArchived) q = q.neq('status', 'archived');
      const { data } = await q.limit(1000);
      return (data ?? []).map(mapRow);
    },
    async getByProject(projectId, sourceId) {
      return getById(projectId, sourceId);
    },
    async update(projectId, sourceId, patch) {
      const dbPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.title !== undefined) dbPatch.title = patch.title;
      if (patch.description !== undefined) dbPatch.description = patch.description;
      if (patch.externalUri !== undefined) dbPatch.external_uri = patch.externalUri;
      if (patch.role !== undefined) dbPatch.role = patch.role;
      // Role is metadata: update only touches sources.role. Nothing downstream is
      // triggered (no re-acquire, re-chunk or re-embed).
      await db.from('sources').update(dbPatch).eq('project_id', projectId).eq('id', sourceId);
      return getById(projectId, sourceId);
    },
    async archive(projectId, sourceId) {
      const now = new Date().toISOString();
      await db
        .from('sources')
        .update({ status: 'archived', archived_at: now, updated_at: now })
        .eq('project_id', projectId)
        .eq('id', sourceId);
      return getById(projectId, sourceId);
    },
    async hardDelete(projectId, sourceId) {
      await db.from('sources').delete().eq('project_id', projectId).eq('id', sourceId);
    },
  };
}