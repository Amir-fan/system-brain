/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K23
 * @purpose Minimal conversation API: create a session (with mode) + send a turn.
 * Server-mediated; the trusted project id + actor are passed to the service/storage.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { Actor } from '../../core/authorization/actor.ts';
import { ConversationFailure, type ConversationMode } from '../../core/conversation/conversation.ts';
import type { ConversationService } from '../../core/conversation/conversation.service.ts';

export interface ConversationApiDeps {
  service: ConversationService;
  boundary: ProjectBoundaryReaders;
}

export type ConversationApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): ConversationApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): ConversationApiResult => ({
  ok: false, status, error: { message, category, ...(code ? { code } : {}) },
});

const isMode = (v: unknown): v is ConversationMode => v === 'contextual' || v === 'private';

export async function handleCreateConversation(
  deps: ConversationApiDeps,
  projectId: string,
  actor: Actor,
  body: Record<string, unknown>,
): Promise<ConversationApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  if (!isMode(body.mode)) return fail('mode must be contextual or private', 'validation');
  try {
    const s = await deps.service.create(projectId, actor, body.mode);
    return ok({ id: s.id, mode: s.mode, status: s.status }, 201);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'could not create conversation', 'conversation', 500);
  }
}

export async function handleConversationMessage(
  deps: ConversationApiDeps,
  projectId: string,
  actor: Actor,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<ConversationApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  try {
    const response = await deps.service.handleMessage(projectId, actor, conversationId, {
      text: typeof body.text === 'string' ? body.text : '',
      ...(Array.isArray(body.answers) ? { answers: body.answers as Array<{ key: string; value: unknown }> } : {}),
      ...(typeof body.skillId === 'string' && body.skillId ? { skillId: body.skillId } : {}),
    });
    return ok(response);
  } catch (e) {
    if (e instanceof ConversationFailure) {
      return fail(e.message, 'conversation', e.code === 'CONVERSATION_NOT_FOUND' ? 404 : 400, e.code);
    }
    return fail('تعذر معالجة الرسالة.', 'conversation', 500);
  }
}
