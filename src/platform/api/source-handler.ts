/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K0-007
 * @purpose Project-scoped Source Registry API handler (url / file / text / connected).
 *
 * Uses the canonical project-boundary authorization primitive (same as Runtime) —
 * never a second authorization implementation. Source = identity + origin +
 * lifecycle; original material lives in raw_artifacts, external identity in
 * external_source_references. No ingestion, no extraction.
 */

import { createHash } from 'node:crypto';
import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { SourceStorage, SourceRecord, SourceType } from '../provider/source.storage.ts';
import { isSourceType } from '../provider/source.storage.ts';
import type { RawArtifactRecord, RawArtifactStorage } from '../provider/raw-artifact.storage.ts';
import type { ExternalConnectionStorage, ExternalReferenceRecord } from '../provider/external-connection.storage.ts';
import type { RawStorage } from '../storage/raw-storage.ts';
import { rawStoragePath } from '../storage/raw-storage.ts';
import type { Actor } from '../../core/authorization/actor.ts';

/** Original-material formats accepted by Knowledge Intake V1 (extension-based). */
export const ACCEPTED_FILE_EXTENSIONS = ['pdf', 'docx', 'txt', 'pptx', 'md'] as const;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;

export interface SourceApiDeps {
  storage: SourceStorage;
  boundary: ProjectBoundaryReaders;
  artifacts: RawArtifactStorage;
  references: ExternalConnectionStorage;
  rawStorage: RawStorage;
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

/** Map a boundary failure to the API error shape (404 vs 403). */
function boundaryFail(auth: { kind: string; message: string }): SourceApiResult {
  return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
}

function publicSource(
  s: SourceRecord,
  artifact?: RawArtifactRecord | null,
  reference?: ExternalReferenceRecord | null,
): unknown {
  return {
    id: s.id,
    sourceType: s.sourceType,
    title: s.title,
    description: s.description ?? undefined,
    externalUri: s.externalUri ?? undefined,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt ?? undefined,
    rawArtifact: artifact
      ? {
          kind: artifact.kind,
          originalName: artifact.originalName,
          mimeType: artifact.mimeType,
          byteSize: artifact.byteSize,
        }
      : undefined,
    externalReference: reference
      ? {
          provider: reference.provider,
          externalItemId: reference.externalItemId,
          externalType: reference.externalType,
          externalUri: reference.externalUri,
          displayName: reference.displayName,
        }
      : undefined,
  };
}

export async function handleListSources(deps: SourceApiDeps, projectId: string, actor: Actor): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const sources = await deps.storage.listByProject(projectId, false);
  const [artifacts, references] = await Promise.all([
    deps.artifacts.listMetadataByProject(projectId),
    deps.references.listReferencesByProject(projectId),
  ]);
  const artifactBySource = new Map(artifacts.map((a) => [a.sourceId, a]));
  const referenceBySource = new Map(references.map((r) => [r.sourceId, r]));
  return ok(sources.map((s) => publicSource(s, artifactBySource.get(s.id), referenceBySource.get(s.id))));
}

export async function handleGetSource(deps: SourceApiDeps, projectId: string, actor: Actor, sourceId: string): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const source = await deps.storage.getByProject(projectId, sourceId);
  if (!source) return fail('source not found', 'not_found', 404);
  const [artifact, reference] = await Promise.all([
    deps.artifacts.getBySource(projectId, sourceId),
    deps.references.getReferenceBySource(projectId, sourceId),
  ]);
  return ok(publicSource(source, artifact, reference));
}

/** URL source: REGISTRATION only — never crawled, scraped, or summarized. */
export async function handleCreateSource(deps: SourceApiDeps, projectId: string, actor: Actor, body: unknown): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);

  const { sourceType, title, description, externalUri } = (body ?? {}) as Record<string, unknown>;
  if (!isSourceType(sourceType)) return fail('unsupported source type', 'validation');
  if (sourceType !== 'url') {
    return fail(`source type '${sourceType}' is not creatable through this route`, 'validation');
  }
  if (typeof title !== 'string' || title.trim().length === 0) return fail('title is required', 'validation');
  if (!validUrl(externalUri)) return fail('a valid http(s) url is required', 'validation');

  const source = await deps.storage.create({
    projectId,
    sourceType,
    title: title.trim(),
    description: typeof description === 'string' ? description.trim() || undefined : undefined,
    externalUri,
    createdBySubject: actor,
  });
  return ok(publicSource(source), 201);
}

/** Pasted text: the original text is the raw artifact. Not chunked, not embedded. */
export async function handleCreateTextSource(deps: SourceApiDeps, projectId: string, actor: Actor, body: unknown): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);

  const { title, content, description } = (body ?? {}) as Record<string, unknown>;
  if (typeof title !== 'string' || title.trim().length === 0) return fail('title is required', 'validation');
  if (typeof content !== 'string' || content.trim().length === 0) return fail('content is required', 'validation');
  if (content.length > MAX_TEXT_CHARS) return fail('content is too large', 'validation');

  const source = await deps.storage.create({
    projectId,
    sourceType: 'text',
    title: title.trim(),
    description: typeof description === 'string' ? description.trim() || undefined : undefined,
    createdBySubject: actor,
  });

  try {
    const artifact = await deps.artifacts.createText({
      projectId,
      sourceId: source.id,
      textContent: content,
      contentSha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    });
    return ok(publicSource(source, artifact), 201);
  } catch {
    // A source without its original material is not a valid source.
    await deps.storage.hardDelete(projectId, source.id).catch(() => {});
    return fail('could not store the pasted text', 'runtime', 500);
  }
}

export interface FileUploadInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  title?: string;
  description?: string;
}

/** File: private storage first, then source + artifact; rolled back on any failure. */
export async function handleCreateFileSource(
  deps: SourceApiDeps,
  projectId: string,
  actor: Actor,
  input: FileUploadInput,
): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);

  const filename = input.filename?.trim();
  if (!filename) return fail('a file is required', 'validation');
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (!(ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    return fail(`unsupported file type (.${ext}) — accepted: ${ACCEPTED_FILE_EXTENSIONS.join(', ')}`, 'validation');
  }
  if (input.bytes.length === 0) return fail('the file is empty', 'validation');
  if (input.bytes.length > MAX_FILE_BYTES) return fail('the file is too large', 'validation');

  const title = input.title?.trim() || filename;
  const description = input.description?.trim() || undefined;

  // Plan ids up-front so the private storage path can be project/source scoped.
  const sourceId = crypto.randomUUID();
  const artifactId = crypto.randomUUID();
  const bucketPath = rawStoragePath({ projectId, sourceId, artifactId, filename });

  try {
    await deps.rawStorage.upload({ projectId, sourceId, artifactId, filename }, input.bytes, input.mimeType || 'application/octet-stream');
  } catch {
    return fail('could not store the file', 'runtime', 500);
  }

  try {
    const source = await deps.storage.create({
      id: sourceId,
      projectId,
      sourceType: 'file',
      title,
      description,
      createdBySubject: actor,
    });
    const artifact = await deps.artifacts.createFile({
      projectId,
      sourceId,
      originalName: filename,
      mimeType: input.mimeType || 'application/octet-stream',
      byteSize: input.bytes.length,
      contentSha256: createHash('sha256').update(input.bytes).digest('hex'),
      storageBucket: 'kip-raw',
      storagePath: bucketPath,
    });
    return ok(publicSource(source, artifact), 201);
  } catch {
    // Compensate: no half-registered file sources, no orphan storage objects.
    await deps.storage.hardDelete(projectId, sourceId).catch(() => {});
    await deps.rawStorage.remove(bucketPath).catch(() => {});
    return fail('could not register the file source', 'runtime', 500);
  }
}

export async function handleUpdateSource(
  deps: SourceApiDeps,
  projectId: string,
  actor: Actor,
  sourceId: string,
  body: unknown,
): Promise<SourceApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);
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
    // Only URL sources can have their origin corrected; connected/owned origins are fixed.
    if (existing.sourceType !== 'url') return fail('this source has no editable url', 'validation');
    if (!validUrl(externalUri)) return fail('a valid http(s) url is required', 'validation');
    patch.externalUri = externalUri;
  }
  const updated = await deps.storage.update(projectId, sourceId, patch as never);
  const [artifact, reference] = await Promise.all([
    deps.artifacts.getBySource(projectId, sourceId),
    deps.references.getReferenceBySource(projectId, sourceId),
  ]);
  return ok(publicSource(updated ?? existing, artifact, reference));
}

export async function handleArchiveSource(deps: SourceApiDeps, projectId: string, actor: Actor, sourceId: string): Promise<SourceApiResult> {
  // manage = owner|service only (destructive/archive)
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'manage');
  if (!auth.ok) return boundaryFail(auth);
  const source = await deps.storage.getByProject(projectId, sourceId);
  if (!source) return fail('source not found', 'not_found', 404);
  if (source.status === 'archived') return fail('source is already archived', 'validation', 400);
  const archived = await deps.storage.archive(projectId, sourceId);
  const [artifact, reference] = await Promise.all([
    deps.artifacts.getBySource(projectId, sourceId),
    deps.references.getReferenceBySource(projectId, sourceId),
  ]);
  return ok(publicSource(archived ?? source, artifact, reference));
}

export type { SourceType };
