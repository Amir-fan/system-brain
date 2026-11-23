import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationFailure, type ConversationSession } from '../src/core/conversation/conversation.ts';
import { createConversationStorage } from '../src/platform/provider/conversation.storage.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const ORIGINAL_UPDATED_AT = '2026-11-15T10:00:00.000Z';
const NEXT_UPDATED_AT = '2026-11-15T10:00:00.001Z';

function session(updatedAt = NEXT_UPDATED_AT): ConversationSession {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: '00000000-0000-4000-8000-000000000002',
    actorSubject: 'actor-1',
    mode: 'contextual',
    status: 'active',
    sessionContext: { facts: {}, turnCount: 1, recentTurns: [] },
    createdAt: '2026-11-15T09:00:00.000Z',
    updatedAt,
  };
}

function fakeUpdateQuery(result: { data: Record<string, unknown> | null; error: { message: string } | null }) {
  const calls = {
    update: undefined as Record<string, unknown> | undefined,
    filters: [] as Array<[string, unknown]>,
  };
  const query = {
    from() { return query; },
    update(values: Record<string, unknown>) { calls.update = values; return query; },
    eq(column: string, value: unknown) { calls.filters.push([column, value]); return query; },
    select() { return query; },
    async maybeSingle() { return result; },
  };
  return { db: query as unknown as SupabaseDatabase, calls };
}

test('conversation save uses the previously read updated_at as a compare-and-swap guard', async () => {
  const next = session();
  const row = {
    id: next.id,
    project_id: next.projectId,
    actor_subject: next.actorSubject,
    mode: next.mode,
    status: next.status,
    session_context: next.sessionContext,
    created_at: next.createdAt,
    updated_at: next.updatedAt,
  };
  const { db, calls } = fakeUpdateQuery({ data: row, error: null });

  await createConversationStorage(db).save(next, ORIGINAL_UPDATED_AT);

  assert.deepEqual(calls.filters, [
    ['project_id', next.projectId],
    ['actor_subject', next.actorSubject],
    ['id', next.id],
    ['updated_at', ORIGINAL_UPDATED_AT],
  ]);
  assert.equal(calls.update?.updated_at, NEXT_UPDATED_AT);
});

test('conversation save reports a typed conflict when the expected version no longer matches', async () => {
  const { db } = fakeUpdateQuery({ data: null, error: null });

  await assert.rejects(
    createConversationStorage(db).save(session(), ORIGINAL_UPDATED_AT),
    (error: unknown) => error instanceof ConversationFailure && error.code === 'CONVERSATION_WRITE_CONFLICT',
  );
});
