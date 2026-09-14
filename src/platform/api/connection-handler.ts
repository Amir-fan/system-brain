/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K0-009
 * @purpose Project-scoped External Connection API handler (GitHub / Google Drive).
 *
 * Connection state is provider-neutral and project-scoped; credentials live in
 * Vault and are never returned here. Browsing items requires a configured
 * connector — until the provider credentials exist this returns an explicit,
 * honest "not configured" error rather than pretending to work.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { ExternalConnectionStorage, ExternalProvider } from '../provider/external-connection.storage.ts';
import { isExternalProvider } from '../provider/external-connection.storage.ts';
import type { SourceStorage } from '../provider/source.storage.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export interface ConnectionApiDeps {
  connections: ExternalConnectionStorage;
  storage: SourceStorage;
  boundary: ProjectBoundaryReaders;
}

export type ConnectionApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string } };

const fail = (message: string, category: string, status = 400): ConnectionApiResult => ({
  ok: false,
  status,
  error: { message, category },
});
const ok = (data: unknown, status = 200): ConnectionApiResult => ({ ok: true, status, data });

function boundaryFail(auth: { kind: string; message: string }): ConnectionApiResult {
  return fail(auth.message, auth.kind === 'not_found' ? 'not_found' : 'authorization', auth.kind === 'not_found' ? 404 : 403);
}

/** Honest public view: no ids beyond the connection's own, no secret references. */
const publicConnection = (c: { provider: string; status: string; accountLabel?: string }) => ({
  provider: c.provider,
  status: c.status,
  accountLabel: c.accountLabel ?? undefined,
});

export async function handleListConnections(
  deps: ConnectionApiDeps,
  projectId: string,
  actor: Actor,
): Promise<ConnectionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  const list = await deps.connections.listConnections(projectId);
  return ok(list.map(publicConnection));
}

/**
 * Browse selectable items for a provider.
 * Requires a configured + connected provider; connector listing arrives with the
 * GitHub App / Google Drive credential slices.
 */
export async function handleListConnectionItems(
  deps: ConnectionApiDeps,
  projectId: string,
  provider: string,
  actor: Actor,
): Promise<ConnectionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);
  if (!isExternalProvider(provider)) return fail('unknown provider', 'validation');

  const connection = await deps.connections.getConnection(projectId, provider);
  if (!connection || connection.status !== 'connected') {
    return fail('connector is not connected', 'validation');
  }
  // Provider browsing is delivered by the dedicated connector slices (K7/K8).
  return fail('connector browsing is not configured yet', 'validation');
}

export interface RegisterExternalSourceInput {
  itemId: string;
  itemType: string;
  name: string;
  uri?: string;
  detail?: string;
}

/** Register a selected external item as a project source (identity only). */
export async function handleRegisterExternalSource(
  deps: ConnectionApiDeps,
  projectId: string,
  provider: string,
  actor: Actor,
  body: unknown,
): Promise<ConnectionApiResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'write');
  if (!auth.ok) return boundaryFail(auth);
  if (!isExternalProvider(provider)) return fail('unknown provider', 'validation');

  const connection = await deps.connections.getConnection(projectId, provider);
  if (!connection || connection.status !== 'connected') {
    return fail('connector is not connected', 'validation');
  }

  const { itemId, itemType, name, uri, detail } = (body ?? {}) as Record<string, unknown>;
  if (typeof itemId !== 'string' || itemId.trim().length === 0) return fail('itemId is required', 'validation');
  if (typeof itemType !== 'string' || itemType.trim().length === 0) return fail('itemType is required', 'validation');
  if (typeof name !== 'string' || name.trim().length === 0) return fail('name is required', 'validation');

  const source = await deps.storage.create({
    projectId,
    sourceType: provider as ExternalProvider as 'github' | 'google_drive',
    title: name.trim(),
    externalUri: typeof uri === 'string' && uri.trim() ? uri.trim() : undefined,
    createdBySubject: actor,
  });

  try {
    const reference = await deps.connections.createReference({
      projectId,
      sourceId: source.id,
      provider,
      connectionId: connection.id,
      externalItemId: itemId.trim(),
      externalType: itemType.trim(),
      externalUri: typeof uri === 'string' && uri.trim() ? uri.trim() : undefined,
      displayName: name.trim(),
      externalPath: typeof detail === 'string' && detail.trim() ? detail.trim() : undefined,
    });
    return ok(
      {
        id: source.id,
        sourceType: source.sourceType,
        title: source.title,
        externalUri: source.externalUri ?? undefined,
        status: source.status,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
        externalReference: {
          provider: reference.provider,
          externalItemId: reference.externalItemId,
          externalType: reference.externalType,
          externalUri: reference.externalUri,
          displayName: reference.displayName,
        },
      },
      201,
    );
  } catch {
    // A connected source without its external reference is not a valid source.
    await deps.storage.hardDelete(projectId, source.id).catch(() => {});
    return fail('could not register the external source', 'runtime', 500);
  }
}
