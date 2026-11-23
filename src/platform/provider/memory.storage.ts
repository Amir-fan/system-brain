/**
 * @kip
 * @module provider
 * @layer platform
 * @owner platform-infra
 * @feature K18
 * @purpose Supabase-backed generic memory persistence.
 *
 * Every query scopes by project_id so no other project's rows are ever touched
 * (RLS is on, no permissive policies; access is server-mediated only).
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import {
  ACTIVE,
  ARCHIVED,
  DEFAULT_RELEVANT_LIMIT,
  MAX_RELEVANT_LIMIT,
  SUPERSEDED,
  isMemorySource,
  isMemoryStatus,
  type ArchiveInput,
  type MemoryProvenance,
  type MemoryRecord,
  type RecallInput,
  type RelevantMemoryQuery,
  type RememberInput,
  type SupersedeInput,
} from '../../core/memory/memory.ts';
import type { MemoryStoragePort } from '../../core/memory/memory.service.ts';

const mapProvenance = (p: Record<string, unknown>): MemoryProvenance => ({
  source: isMemorySource(p.source) ? p.source : 'application',
  ...(typeof p.detail === 'string' && p.detail ? { detail: p.detail } : {}),
});

const mapRow = (r: Record<string, unknown>): MemoryRecord => ({
  id: r.id as string,
  projectId: r.project_id as string,
  scope: r.scope as MemoryRecord['scope'],
  subjectId: r.subject_id as string,
  memoryType: r.memory_type as string,
  memoryKey: r.memory_key as string,
  payload: (r.payload as Record<string, unknown>) ?? {},
  status: isMemoryStatus(r.status) ? r.status : ACTIVE,
  provenance: mapProvenance((r.provenance as Record<string, unknown>) ?? {}),
  validFrom: (r.valid_from as string) ?? undefined,
  supersededById: (r.superseded_by as string) ?? undefined,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export function createMemoryStorage(db: SupabaseDatabase): MemoryStoragePort {
  return {
    async remember(input: RememberInput): Promise<MemoryRecord> {
      const { data, error } = await db
        .from('memory_records')
        .insert({
          project_id: input.projectId,
          scope: input.scope,
          subject_id: input.subjectId,
          memory_type: input.memoryType,
          memory_key: input.memoryKey,
          payload: input.payload,
          provenance: {
            source: isMemorySource(input.provenance?.source) ? input.provenance.source : 'application',
            ...(input.provenance?.detail ? { detail: input.provenance.detail } : {}),
          },
          ...(input.validFrom ? { valid_from: input.validFrom } : {}),
        })
        .select('*')
        .maybeSingle();
      if (error || !data) throw new Error('memory.remember.failed');
      return mapRow(data);
    },

    async recallActive(input: RecallInput): Promise<MemoryRecord[]> {
      let b = db.from('memory_records').select('*').eq('project_id', input.projectId).eq('status', ACTIVE);
      if (input.scope) b = b.eq('scope', input.scope);
      if (input.subjectId) b = b.eq('subject_id', input.subjectId);
      if (input.memoryType) b = b.eq('memory_type', input.memoryType);
      if (input.memoryKey) b = b.eq('memory_key', input.memoryKey);
      const { data } = await b.order('updated_at', { ascending: false }).limit(500);
      return (data ?? []).map(mapRow);
    },

    async history(input: RecallInput): Promise<MemoryRecord[]> {
      let b = db.from('memory_records').select('*').eq('project_id', input.projectId);
      if (input.scope) b = b.eq('scope', input.scope);
      if (input.subjectId) b = b.eq('subject_id', input.subjectId);
      if (input.memoryType) b = b.eq('memory_type', input.memoryType);
      if (input.memoryKey) b = b.eq('memory_key', input.memoryKey);
      const { data } = await b.order('created_at', { ascending: true }).limit(500);
      return (data ?? []).map(mapRow);
    },

    async supersede(input: SupersedeInput): Promise<MemoryRecord> {
      // 1) demote every current ACTIVE record for this logical memory.
      await db
        .from('memory_records')
        .update({ status: SUPERSEDED, updated_at: new Date().toISOString() })
        .eq('project_id', input.projectId)
        .eq('scope', input.scope)
        .eq('subject_id', input.subjectId)
        .eq('memory_type', input.memoryType)
        .eq('memory_key', input.memoryKey)
        .eq('status', ACTIVE);
      // The partial unique index on ACTIVE guarantees at most one current value, so
      // a racing supersede cannot leave two contradictory "current" records.
      return this.remember(input);
    },

    async archive(input: ArchiveInput): Promise<MemoryRecord | null> {
      let query = db
        .from('memory_records')
        .update({ status: ARCHIVED, updated_at: new Date().toISOString() })
        .eq('project_id', input.projectId)
        .eq('id', input.memoryId);
      if (input.scope) query = query.eq('scope', input.scope);
      if (input.subjectId) query = query.eq('subject_id', input.subjectId);
      const { data } = await query.select('*').maybeSingle();
      return data ? mapRow(data) : null;
    },

    async retrieveRelevant(query: RelevantMemoryQuery): Promise<MemoryRecord[]> {
      let b = db.from('memory_records').select('*').eq('project_id', query.projectId).eq('status', ACTIVE);
      if (query.scope) b = b.eq('scope', query.scope);
      if (query.subjectId) b = b.eq('subject_id', query.subjectId);
      if (query.memoryType) b = b.eq('memory_type', query.memoryType);
      // Bounded recency-ordered candidate set (never the whole project), then a
      // deterministic shallow term filter. Deliberately NOT a vector/LLM engine in V1.
      const { data } = await b.order('updated_at', { ascending: false }).limit(MAX_RELEVANT_LIMIT);
      let rows = data ?? [];
      const terms = (query.context ?? '').trim();
      if (terms) {
        const low = terms.toLowerCase();
        rows = rows.filter((r) => {
          const key = ((r.memory_key as string) ?? '').toLowerCase();
          const body = JSON.stringify(r.payload ?? {}).toLowerCase();
          return low.split(/\s+/).some((t) => key.includes(t) || body.includes(t));
        });
      }
      return rows.slice(0, query.limit ?? DEFAULT_RELEVANT_LIMIT).map(mapRow);
    },
  };
}
