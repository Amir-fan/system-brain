/**
 * @kip
 * @module provider
 * @layer platform
 * @owner platform-infra
 * @feature K23
 * @purpose Supabase-backed conversation session persistence (ONE table: conversations).
 * Every query is project- AND actor-scoped, so one project/actor never reaches another's
 * session. session_context holds ONLY session-local continuity (never personal Memory).
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import {
  ConversationFailure,
  emptySessionContext,
  type ConversationSession,
  type SessionContext,
} from '../../core/conversation/conversation.ts';
import type { ConversationStoragePort } from '../../core/conversation/conversation.service.ts';

const mapRow = (r: Record<string, unknown>): ConversationSession => ({
  id: r.id as string,
  projectId: r.project_id as string,
  actorSubject: r.actor_subject as string,
  mode: r.mode as ConversationSession['mode'],
  status: r.status as ConversationSession['status'],
  sessionContext: (r.session_context as SessionContext) ?? emptySessionContext(),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export function createConversationStorage(db: SupabaseDatabase): ConversationStoragePort {
  return {
    async create(session) {
      const { data } = await db
        .from('conversations')
        .insert({
          id: session.id,
          project_id: session.projectId,
          actor_subject: session.actorSubject,
          mode: session.mode,
          status: session.status,
          session_context: session.sessionContext,
        })
        .select('*')
        .maybeSingle();
      if (!data) throw new Error('conversation.create.failed');
      return mapRow(data);
    },

    async get(projectId, actorSubject, conversationId) {
      const { data } = await db
        .from('conversations')
        .select('*')
        .eq('project_id', projectId)
        .eq('actor_subject', actorSubject)
        .eq('id', conversationId)
        .maybeSingle();
      return data ? mapRow(data) : null;
    },

    async save(session, expectedUpdatedAt) {
      const { data, error } = await db
        .from('conversations')
        .update({ session_context: session.sessionContext, updated_at: session.updatedAt })
        .eq('project_id', session.projectId)
        .eq('actor_subject', session.actorSubject)
        .eq('id', session.id)
        .eq('updated_at', expectedUpdatedAt)
        .select('*')
        .maybeSingle();
      if (error) throw new Error('conversation.save.failed');
      if (!data) throw new ConversationFailure('CONVERSATION_WRITE_CONFLICT');
      return mapRow(data);
    },
  };
}
