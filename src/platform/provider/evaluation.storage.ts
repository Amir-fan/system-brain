/**
 * @kip
 * @module provider
 * @layer platform
 * @owner platform-infra
 * @feature K24
 * @purpose Tiny project-scoped persistence for admin test evaluations (K24).
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';

export type ProblemCategory = 'understanding' | 'clarification' | 'context' | 'source' | 'result' | 'wording' | 'other';

export interface EvaluationRecord {
  id: string;
  projectId: string;
  conversationId: string;
  runId?: string | null;
  testerSubject: string;
  isCorrect: boolean;
  problemCategory?: ProblemCategory | null;
  note?: string | null;
  createdAt: string;
}

export interface EvaluationListItem extends EvaluationRecord {
  conversationMode: 'contextual' | 'private' | null;
  conversationStatus: 'active' | 'closed' | null;
  conversationUpdatedAt: string | null;
}

export interface EvaluationStorage {
  conversationAccessible(projectId: string, conversationId: string, actorSubject?: string): Promise<boolean>;
  runAccessible(projectId: string, runId: string, actorSubject?: string): Promise<boolean>;
  save(record: EvaluationRecord): Promise<EvaluationRecord>;
  listRecent(projectId: string, testerSubject: string, limit?: number): Promise<EvaluationListItem[]>;
}

function mapRow(r: Record<string, unknown>): EvaluationRecord {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    conversationId: r.conversation_id as string,
    runId: (r.run_id as string | null) ?? null,
    testerSubject: r.tester_subject as string,
    isCorrect: Boolean(r.is_correct),
    problemCategory: (r.problem_category as ProblemCategory | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export function createEvaluationStorage(db: SupabaseDatabase): EvaluationStorage {
  return {
    async conversationAccessible(projectId, conversationId, actorSubject) {
      let query = db
        .from('conversations')
        .select('id')
        .eq('project_id', projectId)
        .eq('id', conversationId);
      if (actorSubject !== undefined) query = query.eq('actor_subject', actorSubject);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error('evaluation.access.failed');
      return Boolean(data);
    },

    async runAccessible(projectId, runId, actorSubject) {
      let query = db
        .from('runs')
        .select('id')
        .eq('project_id', projectId)
        .eq('id', runId);
      if (actorSubject !== undefined) query = query.eq('actor_subject', actorSubject);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error('evaluation.access.failed');
      return Boolean(data);
    },

    async save(record) {
      const { data } = await db
        .from('evaluation_records')
        .insert({
          id: record.id,
          project_id: record.projectId,
          conversation_id: record.conversationId,
          run_id: record.runId ?? null,
          tester_subject: record.testerSubject,
          is_correct: record.isCorrect,
          problem_category: record.problemCategory ?? null,
          note: record.note ?? null,
        })
        .select('*')
        .maybeSingle();
      if (!data) throw new Error('evaluation.save.failed');
      return mapRow(data);
    },

    async listRecent(projectId, testerSubject, limit = 10) {
      const { data } = await db
        .from('evaluation_records')
        .select('*')
        .eq('project_id', projectId)
        .eq('tester_subject', testerSubject)
        .order('created_at', { ascending: false })
        .limit(limit);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const conversationIds = [...new Set(rows.map((r) => r.conversation_id as string))];
      const conversations =
        conversationIds.length === 0
          ? []
          : await (db
              .from('conversations')
              .select('id, mode, status, updated_at')
              .eq('project_id', projectId)
              .in('id', conversationIds) as unknown as Promise<{ data: Array<Record<string, unknown>> | null }>)
              .then((r) => r.data ?? []);
      const convMap = new Map(
        (conversations as Array<Record<string, unknown>>).map((r) => [r.id as string, r]),
      );
      return rows.map((r) => {
        const c = convMap.get(r.conversation_id as string) ?? null;
        return {
          ...mapRow(r),
          conversationMode: (c?.mode as EvaluationListItem['conversationMode']) ?? null,
          conversationStatus: (c?.status as EvaluationListItem['conversationStatus']) ?? null,
          conversationUpdatedAt: (c?.updated_at as string | null) ?? null,
        };
      });
    },
  };
}
