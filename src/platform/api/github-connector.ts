/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-api
 * @feature K0-010
 * @purpose GitHub App connector: start -> callback -> installation binding -> repositories.
 *
 * The callback is a bare browser redirect (no bearer token), so it is authorized
 * ONLY by the signed state created for the initiating project+actor, plus a fresh
 * membership check. Installation access tokens are minted on demand and never
 * persisted; the OAuth code is never exchanged, echoed, or logged.
 */

import { authorizeProject } from '../../core/authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../../core/authorization/project-boundary.ts';
import type { ExternalConnectionStorage } from '../provider/external-connection.storage.ts';
import type { GitHubAppAuth, GitHubRepository } from '../github/github-app.ts';
import { createConnectionState, verifyConnectionState } from '../github/connection-state.ts';
import type { Actor } from '../../core/authorization/actor.ts';

export interface GitHubConnectorDeps {
  app: GitHubAppAuth;
  /** Server-side secret material used to sign/verify connector state. */
  stateSecret: string;
  connections: ExternalConnectionStorage;
  boundary: ProjectBoundaryReaders;
  /** Where the browser is sent back to after the provider redirect. */
  frontendUrl: string;
}

export type ConnectorResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string } };

const fail = (message: string, category: string, status = 400): ConnectorResult => ({
  ok: false,
  status,
  error: { message, category },
});

function boundaryFail(auth: { kind: string; message: string }): ConnectorResult {
  return fail(
    auth.message,
    auth.kind === 'not_found' ? 'not_found' : 'authorization',
    auth.kind === 'not_found' ? 404 : 403,
  );
}

/** Authenticated: returns the provider URL the browser must be sent to. */
export async function handleGitHubStart(
  deps: GitHubConnectorDeps,
  projectId: string,
  actor: Actor,
): Promise<ConnectorResult> {
  // Connecting grants access to external repositories -> owner|service only.
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'manage');
  if (!auth.ok) return boundaryFail(auth);
  const state = createConnectionState(deps.stateSecret, { projectId, actor });
  return { ok: true, status: 200, data: { url: deps.app.installUrl(state) } };
}

export interface CallbackOutcome {
  /** Absolute URL to send the browser to. */
  redirect: string;
}

const back = (deps: GitHubConnectorDeps, indicator: string) =>
  `${deps.frontendUrl}/knowledge?github=${indicator}`;

/**
 * Provider redirect entry point. Unauthenticated by design; the signed state is
 * the only authority, and membership is re-checked against the live boundary.
 */
export async function handleGitHubCallback(
  deps: GitHubConnectorDeps,
  query: URLSearchParams,
): Promise<CallbackOutcome> {
  const verified = verifyConnectionState(deps.stateSecret, query.get('state') ?? undefined);
  if (!verified.ok) return { redirect: back(deps, 'error') };

  const installationId = (query.get('installation_id') ?? '').trim();
  if (!installationId) return { redirect: back(deps, 'error') };

  const { projectId, actor } = verified.state;
  // The state said who started it; re-verify they may still act on this project.
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'manage');
  if (!auth.ok) return { redirect: back(deps, 'error') };

  try {
    const installation = await deps.app.installation(installationId);
    await deps.connections.saveConnection(projectId, 'github', {
      accountId: installation.id,
      accountLabel: installation.accountLogin,
      // No stored secret: installation tokens are minted on demand, never kept.
    });
    return { redirect: back(deps, 'connected') };
  } catch {
    // Provider failure: generic indicator only, never a raw provider payload.
    return { redirect: back(deps, 'error') };
  }
}

/** Real repositories granted to the installation (never a user-wide listing). */
export async function handleGitHubRepositories(
  deps: GitHubConnectorDeps,
  projectId: string,
  actor: Actor,
): Promise<ConnectorResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'read');
  if (!auth.ok) return boundaryFail(auth);

  const connection = await deps.connections.getConnection(projectId, 'github');
  if (!connection || connection.status !== 'connected' || !connection.accountId) {
    return fail('connector is not connected', 'validation');
  }
  let repos: GitHubRepository[];
  try {
    repos = await deps.app.listInstallationRepositories(connection.accountId);
  } catch {
    return fail('could not load repositories from GitHub', 'runtime', 502);
  }
  return {
    ok: true,
    status: 200,
    data: repos.map((r) => ({
      id: r.id,
      name: r.fullName || r.name,
      type: 'repository',
      uri: r.url,
      detail: r.defaultBranch,
      visibility: r.private ? 'private' : 'public',
    })),
  };
}

/** Revokes provider access. Existing source identity is preserved. */
export async function handleGitHubDisconnect(
  deps: GitHubConnectorDeps,
  projectId: string,
  actor: Actor,
): Promise<ConnectorResult> {
  const auth = await authorizeProject(deps.boundary, projectId, actor, 'manage');
  if (!auth.ok) return boundaryFail(auth);
  await deps.connections.disconnect(projectId, 'github');
  return { ok: true, status: 200, data: { provider: 'github', status: 'not_connected' } };
}
