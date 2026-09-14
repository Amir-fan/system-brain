/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K1-005
 * @purpose Project-scoped grounded answer API.
 *
 * The ordinary response is answer + evidence as a human-readable trace: source and
 * document titles, logical path, heading and an excerpt. Canonical ids are echoed
 * only in debug mode, and vectors, prompts, provider payloads and model reasoning
 * are never returned at all.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { Actor } from '../../core/authorization/actor.ts';
import { KnowledgeAnswerFailure } from '../../core/knowledge/knowledge-answer.ts';
import type { KnowledgeAnswerErrorCode, KnowledgeAnswerResult } from '../../core/knowledge/knowledge-answer.ts';
import type { KnowledgeAnswerService } from '../../core/knowledge/knowledge-answer.service.ts';

export interface KnowledgeAnswerApiDeps {
  service: KnowledgeAnswerService;
  boundary: ProjectBoundaryReaders;
}

export type KnowledgeAnswerApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): KnowledgeAnswerApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): KnowledgeAnswerApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}) },
});

const FAILURE_STATUS: Record<KnowledgeAnswerErrorCode, number> = {
  ANSWER_QUESTION_EMPTY: 400,
  ANSWER_ASSIGNMENT_MISSING: 409,
  ANSWER_RETRIEVAL_UNAVAILABLE: 500,
  ANSWER_PROVIDER_FAILED: 502,
  ANSWER_INVALID_MODEL_OUTPUT: 502,
};

interface AnswerBody {
  question?: unknown;
  language?: unknown;
  topK?: unknown;
  sourceIds?: unknown;
  documentIds?: unknown;
  debug?: unknown;
}

const asIdList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return ids.length > 0 ? ids : undefined;
};

/** Evidence as a user-facing trace: no vectors, no internal ids unless debugging. */
const publicEvidence = (result: KnowledgeAnswerResult, debug: boolean) =>
  result.evidence.map((e) => ({
    label: e.label,
    sourceTitle: e.sourceTitle ?? null,
    documentTitle: e.documentTitle ?? null,
    logicalPath: e.logicalPath ?? null,
    headingContext: e.headingContext ?? null,
    excerpt: e.excerpt,
    ...(debug
      ? {
          sourceId: e.sourceId,
          documentId: e.documentId,
          chunkId: e.chunkId,
          fusedScore: e.fusedScore,
          foundBy: e.foundBy,
        }
      : {}),
  }));

export async function handleKnowledgeAnswer(
  deps: KnowledgeAnswerApiDeps,
  projectId: string,
  actor: Actor,
  body: AnswerBody,
): Promise<KnowledgeAnswerApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) {
    return fail(
      auth.message,
      auth.kind === 'not_found' ? 'not_found' : 'authorization',
      auth.kind === 'not_found' ? 404 : 403,
    );
  }

  const question = typeof body.question === 'string' ? body.question : '';
  const debug = body.debug === true;
  const language = body.language === 'ar' || body.language === 'en' ? body.language : undefined;
  const rawTopK = typeof body.topK === 'number' && Number.isFinite(body.topK) ? Math.trunc(body.topK) : undefined;
  const topK = rawTopK === undefined ? undefined : Math.min(Math.max(rawTopK, 1), 20);

  let result: KnowledgeAnswerResult;
  try {
    result = await deps.service.answer({
      projectId,
      question,
      ...(language ? { language } : {}),
      ...(topK !== undefined ? { topK } : {}),
      filters: {
        ...(asIdList(body.sourceIds) ? { sourceIds: asIdList(body.sourceIds) as string[] } : {}),
        ...(asIdList(body.documentIds) ? { documentIds: asIdList(body.documentIds) as string[] } : {}),
      },
    });
  } catch (error) {
    if (error instanceof KnowledgeAnswerFailure) {
      return fail(error.message, 'knowledge_answer', FAILURE_STATUS[error.code], error.code);
    }
    return fail('تعذر توليد الإجابة.', 'knowledge_answer', 500);
  }

  return ok({
    status: result.status,
    answer: result.answer ?? null,
    message: result.message ?? null,
    clarification: result.clarification ?? null,
    confidence: result.confidence,
    evidence: publicEvidence(result, debug),
    ...(debug
      ? {
          model: result.model ?? null,
          retrievalSummary: result.retrievalSummary,
          reasoningSignals: result.reasoningSignals,
          timings: result.timings,
        }
      : {}),
  });
}
