/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K18
 * @purpose Project-scoped Memory API: remember / recall / supersede / archive / relevant.
 *
 * Minimal surface to prove Memory V1 — no large management API, no admin UI. Every
 * operation is authorized through the canonical project boundary and the trusted
 * project id is passed to the service/storage (server-mediated isolation).
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { Actor } from '../../core/authorization/actor.ts';
import type { Role } from '../../core/authorization/actor.ts';
import { MemoryFailure, isMemoryScope, MEMORY_SCOPES } from '../../core/memory/memory.ts';
import type { MemoryScope } from '../../core/memory/memory.ts';
import type { MemoryService } from '../../core/memory/memory.service.ts';

export interface MemoryApiDeps {
  service: MemoryService;
  boundary: ProjectBoundaryReaders;
}

export type MemoryApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string; code?: string } };

const ok = (data: unknown, status = 200): MemoryApiResult => ({ ok: true, status, data });
const fail = (message: string, category: string, status = 400, code?: string): MemoryApiResult => ({
  ok: false,
  status,
  error: { message, category, ...(code ? { code } : {}) },
});

interface AuthResult {
  projectId: string;
  role: Role;
}
async function authorize(deps: MemoryApiDeps, projectId: string, actor: Actor, op: 'read' | 'write'): Promise<AuthResult | MemoryApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, op);
  if (!auth.ok) {
    return fail(
      auth.message,
      auth.kind === 'not_found' ? 'not_found' : 'authorization',
      auth.kind === 'not_found' ? 404 : 403,
    );
  }
  return { projectId, role: auth.membership.role };
}

function memoryError(error: unknown): MemoryApiResult {
  if (error instanceof MemoryFailure) {
    return fail(error.message, 'memory', 400, error.code);
  }
  return fail('تعذر تنفيذ العملية على الذاكرة.', 'memory', 500);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const scopeOf = (v: unknown): MemoryScope | undefined => (isMemoryScope(v) ? v : undefined);

interface SubjectAccess {
  scope?: MemoryScope;
  subjectId?: string;
}

/**
 * Public end-user memory is always bound to the authenticated actor. Conversation
 * and case subjects are resource identifiers, not identities, so they require the
 * trusted service path until an ownership resolver exists for those resources.
 */
function authorizeSubject(
  auth: AuthResult,
  actor: Actor,
  requestedScope: MemoryScope | undefined,
  requestedSubjectId: string | undefined,
): SubjectAccess | MemoryApiResult {
  if (auth.role === 'service') {
    return {
      ...(requestedScope ? { scope: requestedScope } : {}),
      ...(requestedSubjectId ? { subjectId: requestedSubjectId } : {}),
    };
  }
  if (requestedScope !== undefined && requestedScope !== 'user') {
    return fail('memory subject is not authorized', 'authorization', 403, 'MEMORY_SUBJECT_FORBIDDEN');
  }
  if (requestedSubjectId !== undefined && requestedSubjectId !== actor) {
    return fail('memory subject is not authorized', 'authorization', 403, 'MEMORY_SUBJECT_FORBIDDEN');
  }
  return { scope: 'user', subjectId: actor };
}

export async function handleMemoryRemember(
  deps: MemoryApiDeps,
  projectId: string,
  actor: Actor,
  body: Record<string, unknown>,
): Promise<MemoryApiResult> {
  const a = await authorize(deps, projectId, actor, 'write');
  if (!('projectId' in a)) return a;
  const scope = scopeOf(body.scope);
  if (!scope) return fail('scope must be one of: ' + MEMORY_SCOPES.join(', '), 'memory', 400);
  const payload = rec(body.payload);
  if (!payload) return fail('payload must be a JSON object', 'memory', 400);
  const subject = authorizeSubject(a, actor, scope, str(body.subjectId));
  if ('status' in subject) return subject;
  try {
    const record = await deps.service.remember({
      projectId: a.projectId,
      scope: subject.scope ?? scope,
      subjectId: subject.subjectId ?? '',
      memoryType: str(body.type) ?? '',
      memoryKey: str(body.key) ?? '',
      payload,
      ...(rec(body.provenance) ? { provenance: rec(body.provenance) } : {}),
      ...(str(body.validFrom) ? { validFrom: body.validFrom as string } : {}),
    });
    return ok(record, 201);
  } catch (e) {
    return memoryError(e);
  }
}

export async function handleMemorySupersede(
  deps: MemoryApiDeps,
  projectId: string,
  actor: Actor,
  body: Record<string, unknown>,
): Promise<MemoryApiResult> {
  const a = await authorize(deps, projectId, actor, 'write');
  if (!('projectId' in a)) return a;
  const scope = scopeOf(body.scope);
  if (!scope) return fail('scope must be one of: ' + MEMORY_SCOPES.join(', '), 'memory', 400);
  const payload = rec(body.payload);
  if (!payload) return fail('payload must be a JSON object', 'memory', 400);
  const subject = authorizeSubject(a, actor, scope, str(body.subjectId));
  if ('status' in subject) return subject;
  try {
    const record = await deps.service.supersede({
      projectId: a.projectId,
      scope: subject.scope ?? scope,
      subjectId: subject.subjectId ?? '',
      memoryType: str(body.type) ?? '',
      memoryKey: str(body.key) ?? '',
      payload,
      ...(rec(body.provenance) ? { provenance: rec(body.provenance) } : {}),
      ...(str(body.validFrom) ? { validFrom: body.validFrom as string } : {}),
    });
    return ok(record, 201);
  } catch (e) {
    return memoryError(e);
  }
}

export async function handleMemoryRecall(
  deps: MemoryApiDeps,
  projectId: string,
  actor: Actor,
  query: URLSearchParams,
): Promise<MemoryApiResult> {
  const a = await authorize(deps, projectId, actor, 'read');
  if (!('projectId' in a)) return a;
  const rawScope = query.get('scope');
  if (rawScope !== null && !scopeOf(rawScope)) return fail('invalid memory scope', 'memory', 400, 'MEMORY_SCOPE_INVALID');
  const subject = authorizeSubject(a, actor, scopeOf(rawScope ?? undefined), str(query.get('subjectId')));
  if ('status' in subject) return subject;
  try {
    const records = await deps.service.recall({
      projectId: a.projectId,
      ...(subject.scope ? { scope: subject.scope } : {}),
      ...(subject.subjectId ? { subjectId: subject.subjectId } : {}),
      ...(str(query.get('type')) ? { memoryType: query.get('type') as string } : {}),
      ...(str(query.get('key')) ? { memoryKey: query.get('key') as string } : {}),
    });
    return ok(records);
  } catch (e) {
    return memoryError(e);
  }
}

export async function handleMemoryHistory(
  deps: MemoryApiDeps,
  projectId: string,
  actor: Actor,
  query: URLSearchParams,
): Promise<MemoryApiResult> {
  const a = await authorize(deps, projectId, actor, 'read');
  if (!('projectId' in a)) return a;
  const rawScope = query.get('scope');
  if (rawScope !== null && !scopeOf(rawScope)) return fail('invalid memory scope', 'memory', 400, 'MEMORY_SCOPE_INVALID');
  const subject = authorizeSubject(a, actor, scopeOf(rawScope ?? undefined), str(query.get('subjectId')));
  if ('status' in subject) return subject;
  try {
    const records = await deps.service.history({
      projectId: a.projectId,
      ...(subject.scope ? { scope: subject.scope } : {}),
      ...(subject.subjectId ? { subjectId: subject.subjectId } : {}),
      ...(str(query.get('type')) ? { memoryType: query.get('type') as string } : {}),
      ...(str(query.get('key')) ? { memoryKey: query.get('key') as string } : {}),
    });
    return ok(records);
  } catch (e) {
    return memoryError(e);
  }
}

export async function handleMemoryArchive(
  deps: MemoryApiDeps,
  projectId: string,
  actor: Actor,
  body: Record<string, unknown>,
): Promise<MemoryApiResult> {
  const a = await authorize(deps, projectId, actor, 'write');
  if (!('projectId' in a)) return a;
  const memoryId = str(body.id);
  if (!memoryId) return fail('memory id is required', 'memory', 400);
  try {
    const archived = await deps.service.archive({
      projectId: a.projectId,
      memoryId,
      ...(a.role === 'service' ? {} : { scope: 'user' as const, subjectId: actor }),
    });
    if (!archived) return fail('memory not found', 'memory', 404);
    return ok(archived);
  } catch (e) {
    return memoryError(e);
  }
}

export async function handleMemoryRetrieve(
  deps: MemoryApiDeps,
  projectId: string,
  actor: Actor,
  body: Record<string, unknown>,
): Promise<MemoryApiResult> {
  const a = await authorize(deps, projectId, actor, 'read');
  if (!('projectId' in a)) return a;
  const rawLimit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.trunc(body.limit) : undefined;
  const requestedScope = scopeOf(body.scope);
  if (body.scope !== undefined && !requestedScope) return fail('invalid memory scope', 'memory', 400, 'MEMORY_SCOPE_INVALID');
  const subject = authorizeSubject(a, actor, requestedScope, str(body.subjectId));
  if ('status' in subject) return subject;
  try {
    const records = await deps.service.retrieveRelevant({
      projectId: a.projectId,
      ...(str(body.context) ? { context: body.context as string } : {}),
      ...(subject.scope ? { scope: subject.scope } : {}),
      ...(subject.subjectId ? { subjectId: subject.subjectId } : {}),
      ...(str(body.type) ? { memoryType: body.type as string } : {}),
      ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
    });
    return ok(records);
  } catch (e) {
    return memoryError(e);
  }
}
