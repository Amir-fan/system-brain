/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K19
 * @purpose Project-scoped Understanding API. Minimal surface — no UI.
 *
 * Assemblies bounded relevant context via the injected contextFetcher (wired to the
 * existing MemoryService), then evaluates a structured UnderstandingResult.
 * Understanding never writes memory; if a caller later decides to persist a
 * correction it does so explicitly through the Memory API.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { Actor } from '../../core/authorization/actor.ts';
import { UnderstandingFailure } from '../../core/understanding/understanding.ts';
import type { BoundedUnderstandingContext } from '../../core/understanding/understanding.ts';
import type { UnderstandingService } from '../../core/understanding/understanding.service.ts';

export interface UnderstandingApiDeps {
  service: UnderstandingService;
  /** Bounded relevant context from the existing MemoryService (never a full dump). */
  contextFetcher: (projectId: string, ids: { subjectId?: string; conversationId?: string; caseId?: string }) => Promise<BoundedUnderstandingContext>;
  boundary: ProjectBoundaryReaders;
}

export type UnderstandingApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): UnderstandingApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): UnderstandingApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}) },
});

export async function handleUnderstandingEvaluate(
  deps: UnderstandingApiDeps,
  projectId: string,
  actor: Actor,
  body: Record<string, unknown>,
): Promise<UnderstandingApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) {
    return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  }
  const text = typeof body.text === 'string' ? body.text : '';
  const subjectId = typeof body.subjectId === 'string' && body.subjectId ? (body.subjectId as string) : undefined;
  const conversationId = typeof body.conversationId === 'string' && body.conversationId ? (body.conversationId as string) : undefined;
  const caseId = typeof body.caseId === 'string' && body.caseId ? (body.caseId as string) : undefined;
  const requestTimestamp = typeof body.requestTimestamp === 'string' && body.requestTimestamp ? (body.requestTimestamp as string) : undefined;

  try {
    const context = await deps.contextFetcher(projectId, { subjectId, conversationId, caseId });
    const result = await deps.service.evaluate({
      projectId,
      text,
      ...(subjectId ? { subjectId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(caseId ? { caseId } : {}),
      ...(requestTimestamp ? { requestTimestamp } : {}),
      context,
    });
    return ok(result);
  } catch (e) {
    if (e instanceof UnderstandingFailure) {
      return fail(e.message, 'understanding', 400, e.code);
    }
    return fail('تعذر فهم الإدخال.', 'understanding', 500);
  }
}
