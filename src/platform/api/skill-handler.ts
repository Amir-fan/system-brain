/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K20
 * @purpose Project-scoped Skills API: list registry + execute a Skill.
 *
 * Execution is server-mediated (authorized via the canonical boundary); the Skill
 * receives only declared dependencies and never a DB client, provider SDK or secret.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { Actor } from '../../core/authorization/actor.ts';
import { SkillFailure } from '../../core/skill/skill.ts';
import type { SkillExecutionResult } from '../../core/skill/skill.ts';
import type { SkillRegistry } from '../../core/skill/skill-registry.ts';
import type { SkillsRuntime } from '../../core/skill/skill-runtime.ts';

export interface SkillsApiDeps {
  runtime: SkillsRuntime;
  registry: SkillRegistry;
  boundary: ProjectBoundaryReaders;
}

export type SkillsApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): SkillsApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): SkillsApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}) },
});

export async function handleSkillList(
  deps: SkillsApiDeps,
  projectId: string,
  actor: Actor,
): Promise<SkillsApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) {
    return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  }
  return ok(
    deps.registry.list().map((s) => ({ id: s.id, version: s.version, description: s.description, requirements: s.requirements })),
  );
}

export async function handleSkillExecute(
  deps: SkillsApiDeps,
  projectId: string,
  actor: Actor,
  skillId: string,
  body: Record<string, unknown>,
): Promise<SkillsApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) {
    return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  }
  const subjectId = typeof body.subjectId === 'string' && body.subjectId ? (body.subjectId as string) : undefined;
  const conversationId = typeof body.conversationId === 'string' && body.conversationId ? (body.conversationId as string) : undefined;
  const caseId = typeof body.caseId === 'string' && body.caseId ? (body.caseId as string) : undefined;
  const requestTimestamp = typeof body.requestTimestamp === 'string' && body.requestTimestamp ? (body.requestTimestamp as string) : undefined;
  const payload = 'payload' in body ? body.payload : undefined;

  try {
    const result: SkillExecutionResult = await deps.runtime.execute({
      projectId,
      actor,
      skillId,
      payload,
      ...(subjectId ? { subjectId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(caseId ? { caseId } : {}),
      ...(requestTimestamp ? { requestTimestamp } : {}),
    });
    return ok(result, result.status === 'failed' ? 400 : 200);
  } catch (e) {
    if (e instanceof SkillFailure) {
      return fail(e.message, 'skill', e.code === 'SKILL_NOT_FOUND' ? 404 : 400, e.code);
    }
    return fail('تعذر تنفيذ المهارة.', 'skill', 500);
  }
}
