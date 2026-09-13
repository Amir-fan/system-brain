/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K0-007
 * @purpose Project-scoped Source Registry API handler.
 *
 * Uses the canonical project-boundary authorization primitive (same as Runtime) —
 * never a second authorization implementation. Sources are project-scoped:
 * source.project_id must always match the route projectId.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { SourceStorage, SourceRecord } from '../provider/source.storage.ts';
import { isSourceType } from '../provider/source.storage.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export interface SourceApiDeps {
  storage: SourceStorage;
  boundary: ProjectBoundaryReaders;
}

export type SourceApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string } };

function fail(message: string, category: string, status = 400): SourceApiResult {
  return { ok: false, status, error: { message, category } };
}
const ok = (data: unknown, status = 200): SourceApiResult => ({ ok: true, status, data });

function validUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 2048) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function handleListSources(deps: SourceApiDeps, projectId: string, actor: Actor): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  const sources = await deps.storage.listByProject(projectId, false);
  return ok(sources.map(publicSource));
}

export async function handleCreateSource(deps: SourceApiDeps, projectId: string, actor: Actor, body: unknown): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);

  const { sourceType, title, description, externalUri } = (body ?? {}) as Record<string, unknown>;
  if (!isSourceType(sourceType)) return fail(`unsupported source_type (implemented: url)`, 'validation');
  if (typeof title !== 'string' || title.trim().length === 0) return fail('title is required', 'validation');
  if (!validUrl(externalUri)) return fail('a valid http(s) url is required', 'validation');

  const source = await deps.storage.create({
    projectId,
    sourceType,
    title: title.trim(),
    description: typeof description === 'string' ? description.trim() || undefined : undefined,
    externalUri,
    createdBySubject: actor, // source creation is always authenticated
  });
  return ok(publicSource(source), 201);
}

export async function handleGetSource(deps: SourceApiDeps, projectId: string, actor: Actor, sourceId: string): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  const source = await deps.storage.getByProject(projectId, sourceId);
  if (!source) return fail('source not found', 'not_found', 404);
  return ok(publicSource(source));
}

export async function handleUpdateSource(
  deps: SourceApiDeps,
  projectId: string,
  actor: Actor,
  sourceId: string,
  body: unknown,
): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  const existing = await deps.storage.getByProject(projectId, sourceId);
  if (!existing) return fail('source not found', 'not_found', 404);
  if (existing.status === 'archived') return fail('archived sources cannot be edited', 'validation', 400);

  // Only user-editable metadata; status is NOT editable here.
  const patch: Record<string, unknown> = {};
  const { title, description, externalUri } = (body ?? {}) as Record<string, unknown>;
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) return fail('title must be a non-empty string', 'validation');
    patch.title = title.trim();
  }
  if (description !== undefined) {
    patch.description = typeof description === 'string' ? description.trim() || null : null;
  }
  if (externalUri !== undefined) {
    if (!validUrl(externalUri)) return fail('a valid http(s) url is required', 'validation');
    patch.externalUri = externalUri;
  }
  const updated = await deps.storage.update(projectId, sourceId, patch as never);
  return ok(publicSource((updated ?? existing)));
}

export async function handleArchiveSource(deps: SourceApiDeps, projectId: string, actor: Actor, sourceId: string): Promise<SourceApiResult> {
  // manage = owner|service only (destructive/archive)
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'manage');
  if (!auth.ok) return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
  const source = await deps.storage.getByProject(projectId, sourceId);
  if (!source) return fail('source not found', 'not_found', 404);
  if (source.status === 'archived') return fail('source is already archived', 'validation', 400);
  const archived = await deps.storage.archive(projectId, sourceId);
  return ok(publicSource((archived ?? source)));
}

function publicSource(s: SourceRecord): unknown {
  return {
    id: s.id,
    sourceType: s.sourceType,
    title: s.title,
    description: s.description ?? undefined,
    externalUri: s.externalUri,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt ?? undefined,
  };
}