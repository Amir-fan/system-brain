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
import { isProviderError } from '../../core/model-gateway/gateway-errors.ts';
import type { ConversationService } from '../../core/conversation/conversation.service.ts';
import type { EvaluationStorage, ProblemCategory } from '../provider/evaluation.storage.ts';

export interface ConversationApiDeps {
  service: ConversationService;
  boundary: ProjectBoundaryReaders;
  /**
   * Trusted provisioning writer (Stage 3 cutover). Present only on the server-mediated
   * path; used ONLY by the proxy-gated membership endpoint — never by end users.
   */
  membershipWriter?: { ensureMembership(projectId: string, actor: Actor, role: 'member'): Promise<unknown> };
  evaluation?: { storage: EvaluationStorage; boundary: ProjectBoundaryReaders };
}

export type ConversationApiResult =
  | { ok: true; status: number; data: unknown }
  | {
      ok: false;
      status: number;
      error: {
        message: string;
        category: string;
        code?: string;
        /** Technical execution trace for the INTERNAL tester (durations/stages/codes only;
         *  never prompts, model reasoning or credentials). */
        diagnostics?: unknown;
      };
    };

const ok = (data: unknown, status = 200): ConversationApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string, diagnostics?: unknown): ConversationApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}), ...(diagnostics !== undefined ? { diagnostics } : {}) },
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
      // Stage 2 bridge: pass generic app context through (opaque; the conversation layer
      // enforces the mode gate and provenance rank).
      ...(body.appContext && typeof body.appContext === 'object' ? { appContext: body.appContext as Record<string, unknown> } : {}),
    });
    return ok(response);
  } catch (e) {
    if (e instanceof ConversationFailure) {
      const status = e.code === 'CONVERSATION_NOT_FOUND'
        ? 404
        : e.code === 'CONVERSATION_WRITE_CONFLICT'
          ? 409
          : 400;
      return fail(e.message, 'conversation', status, e.code);
    }
    // Provider/transport failure = temporary infrastructure problem, NOT a domain verdict:
    // reported as retryable, with no provider name, stack trace or HTTP internals exposed.
    const diagnostics = (e as { execution?: unknown } | null)?.execution;
    if (isProviderError(e)) {
      return fail('تعذر إكمال الطلب مؤقتًا. حاولي مرة أخرى.', 'provider', 503, undefined, diagnostics);
    }
    return fail('تعذر معالجة الرسالة.', 'conversation', 500, undefined, diagnostics);
  }
}

const CATEGORIES: ProblemCategory[] = ['understanding', 'clarification', 'context', 'source', 'result', 'wording', 'other'];

/** POST /v1/projects/{p}/conversations/{id}/evaluation — tiny admin test evaluation. */
export async function handleSaveConversationEvaluation(
  deps: ConversationApiDeps,
  projectId: string,
  actor: Actor,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<ConversationApiResult> {
  if (!deps.evaluation) return fail('evaluation storage not configured', 'runtime', 500);
  const auth = await authorizeProject(deps.evaluation.boundary, projectId, actor, 'write');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  if (typeof body.isCorrect !== 'boolean') return fail('isCorrect must be boolean', 'validation');
  const rawCategory = body.problemCategory;
  const problemCategory = typeof rawCategory === 'string' && CATEGORIES.includes(rawCategory as ProblemCategory)
    ? (rawCategory as ProblemCategory)
    : undefined;
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
  const runId = typeof body.runId === 'string' && body.runId ? body.runId : undefined;
  try {
    const actorSubject = auth.membership.role === 'service' ? undefined : actor;
    if (!await deps.evaluation.storage.conversationAccessible(projectId, conversationId, actorSubject)) {
      return fail('evaluation target not found', 'not_found', 404, 'EVALUATION_TARGET_NOT_FOUND');
    }
    if (runId && !await deps.evaluation.storage.runAccessible(projectId, runId, actorSubject)) {
      return fail('evaluation target not found', 'not_found', 404, 'EVALUATION_TARGET_NOT_FOUND');
    }
    const record = await deps.evaluation.storage.save({
      id: crypto.randomUUID(),
      projectId,
      conversationId,
      runId,
      testerSubject: actor,
      isCorrect: body.isCorrect,
      problemCategory,
      note,
      createdAt: new Date().toISOString(),
    });
    return ok({ id: record.id, ...(record.problemCategory ? { problemCategory: record.problemCategory } : {}) }, 201);
  } catch {
    return fail('تعذر حفظ التقييم', 'runtime', 500);
  }
}

/** GET /v1/projects/{p}/conversations/evaluations — recent evaluations for this tester. */
export async function handleListConversationEvaluations(
  deps: ConversationApiDeps,
  projectId: string,
  actor: Actor,
): Promise<ConversationApiResult> {
  if (!deps.evaluation) return fail('evaluation storage not configured', 'runtime', 500);
  const auth = await authorizeProject(deps.evaluation.boundary, projectId, actor, 'read');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  try {
    const items = await deps.evaluation.storage.listRecent(projectId, actor, 10);
    return ok(items);
  } catch {
    return fail('تعذر جلب التقييمات', 'runtime', 500);
  }
}

/**
 * POST /v1/projects/{p}/memberships — trusted server-to-server provisioning (Stage 3).
 *
 * The ONLY caller is a trusted proxy-authenticated service actor (KIP_PROXY_TOKENS) that
 * has ALREADY verified the end user's identity upstream (Naqaa JWT). The service actor
 * must hold `manage` on the target project; the provisioned subject is always role
 * `member` and an existing stronger membership is never downgraded (idempotent).
 *
 * `isProxy` is mandatory: a delegated end-user actor (`x-kip-actor`) can NEVER provision
 * — only the service identity itself. An arbitrary client cannot reach this path.
 */
export async function handleProvisionMembership(
  deps: ConversationApiDeps,
  projectId: string,
  serviceActor: Actor,
  isProxy: boolean,
  body: Record<string, unknown>,
): Promise<ConversationApiResult> {
  if (!isProxy) return fail('provisioning requires the trusted proxy credential', 'authorization', 403);
  if (!deps.membershipWriter) return fail('provisioning not configured', 'runtime', 500);
  const auth = await authorizeProject(deps.boundary, projectId, serviceActor, 'manage');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  const subject = typeof body.subject_id === 'string' ? body.subject_id.trim() : '';
  if (!subject || subject.length > 200) return fail('subject_id required', 'validation');
  // A provisioned member is ALWAYS role 'member' — the caller can never elevate a subject.
  try {
    const m = (await deps.membershipWriter.ensureMembership(projectId, subject, 'member')) as {
      projectId: string; actor: string; role: string; createdAt: string;
    };
    return ok({ projectId: m.projectId, subject: m.actor, role: m.role }, 200);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'provisioning failed', 'runtime', 500);
  }
}
