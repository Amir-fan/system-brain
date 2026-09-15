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
  return { projectId };
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
  try {
    const record = await deps.service.remember({
      projectId: a.projectId,
      scope,
      subjectId: str(body.subjectId) ?? '',
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
  try {
    const record = await deps.service.supersede({
      projectId: a.projectId,
      scope,
      subjectId: str(body.subjectId) ?? '',
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
  try {
    const records = await deps.service.recall({
      projectId: a.projectId,
      ...(scopeOf(query.get('scope') ?? undefined) ? { scope: scopeOf(query.get('scope') ?? undefined) } : {}),
      ...(str(query.get('subjectId')) ? { subjectId: query.get('subjectId') as string } : {}),
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
  try {
    const records = await deps.service.history({
      projectId: a.projectId,
      ...(scopeOf(query.get('scope') ?? undefined) ? { scope: scopeOf(query.get('scope') ?? undefined) } : {}),
      ...(str(query.get('subjectId')) ? { subjectId: query.get('subjectId') as string } : {}),
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
    const archived = await deps.service.archive({ projectId: a.projectId, memoryId });
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
  try {
    const records = await deps.service.retrieveRelevant({
      projectId: a.projectId,
      ...(str(body.context) ? { context: body.context as string } : {}),
      ...(scopeOf(body.scope) ? { scope: scopeOf(body.scope) as never } : {}),
      ...(str(body.subjectId) ? { subjectId: body.subjectId as string } : {}),
      ...(str(body.type) ? { memoryType: body.type as string } : {}),
      ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
    });
    return ok(records);
  } catch (e) {
    return memoryError(e);
  }
}
