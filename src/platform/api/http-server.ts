/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Minimal Node-native HTTP listener for the KIP API (project + admin routes).
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { handleInvoke } from './api-handler.ts';
import type { TokenActorMap } from './auth.ts';
import { isPlatformAdmin, bearerFromHeader } from './admin-auth.ts';
import type { AdminProviderApiDeps } from './admin-provider.ts';
import {
  connectProvider,
  listProviders,
  revokeProvider,
  testConnection,
  listProviderModels,
  listAssignments,
  putAssignment,
  deleteAssignment,
} from './admin-provider.ts';
import type { ProviderStorage } from '../provider/provider.storage.ts';
import type { ErrorCategory } from '../../core/run/run.ts';
import type { ApiResult } from './api.types.ts';
import type { SourceApiDeps } from './source-handler.ts';
import {
  handleListSources,
  handleCreateSource,
  handleGetSource,
  handleUpdateSource,
  handleArchiveSource,
  handleCreateTextSource,
  handleCreateFileSource,
} from './source-handler.ts';
import type { ConnectionApiDeps } from './connection-handler.ts';
import {
  handleListConnections,
  handleListConnectionItems,
  handleRegisterExternalSource,
} from './connection-handler.ts';
import type { DocumentApiDeps } from './document-handler.ts';
import { handleListSourceDocuments, handleGetDocument } from './document-handler.ts';
import type { IngestionApiDeps } from './ingestion-handler.ts';
import {
  handleCreateIngestion,
  handleListSourceIngestions,
  handleListProjectIngestions,
  handleGetIngestion,
  handleRetryIngestion,
} from './ingestion-handler.ts';
import type { GitHubConnectorDeps } from './github-connector.ts';
import {
  handleGitHubStart,
  handleGitHubCallback,
  handleGitHubRepositories,
  handleGitHubDisconnect,
} from './github-connector.ts';
import type { ActorAuthenticator } from './actor-authenticator.ts';
import { UnauthenticatedError } from './actor-authenticator.ts';
import type { ProjectDiscoveryStorage } from './project-discovery.ts';
import { handleListMyProjects } from './project-discovery.ts';

export interface HttpApiDeps {
  runtime: Pick<import('../../core/runtime/runtime.service.ts').RuntimeService, 'execute'>;
  authenticator: ActorAuthenticator;
  projects?: ProjectDiscoveryStorage;
  sources?: SourceApiDeps;
  connections?: ConnectionApiDeps;
  github?: GitHubConnectorDeps;
  ingestion?: IngestionApiDeps;
  documents?: DocumentApiDeps;
  admin?: {
    storage: ProviderStorage;
    adminApi: AdminProviderApiDeps;
  };
}

const ROUTE = /^\/v1\/projects\/([^/]+)\/runs$/;
const SOURCES_RE = /^\/v1\/projects\/([^/]+)\/sources(?:\/([^/]+))?$/;
const MY_PROJECTS_RE = /^\/v1\/projects$/;
const ADMIN_ROUTE = /^\/v1\/admin\/providers(?:\/([^/]+)(?:\/(test|revoke|models))?)?$/;

export function createHttpApi(deps: HttpApiDeps): Server {
  return createServer(async (req, res) => {
    try {
      const url = req.url ?? '';
      if (url.startsWith('/v1/admin')) {
        return handleAdmin(req, res, url, deps);
      }
      // Provider redirect endpoints: browser navigation, no bearer token exists.
      // Authority comes from the signed state, never from query parameters.
      if (url.startsWith('/v1/connections/')) {
        return handleProviderRedirect(res, url, deps);
      }
      return handleProject(req, res, url, deps);
    } catch {
      return sendJson(res, 500, { ok: false, status: 500, error: { category: 'runtime', message: 'internal error' } });
    }
  });
}

async function handleProject(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: string,
  deps: HttpApiDeps,
): Promise<void> {
  if (url === '/v1/projects' || MY_PROJECTS_RE.test(url)) {
    if (req.method !== 'GET') return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
    if (!deps.projects) return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
    const actor = await resolveActor(req, res, deps);
    if (!actor) return;
    const result = await handleListMyProjects(deps.projects, actor);
    return sendJson(res, result.status, { ok: result.ok, status: result.status, ...(result.ok ? { data: result.data } : { error: result.error }) } as ApiResult);
  }
  if (url.includes('/documents')) {
    return handleDocuments(req, res, url, deps);
  }
  if (url.includes('/ingestions')) {
    return handleIngestions(req, res, url, deps);
  }
  if (url.includes('/connections')) {
    return handleConnections(req, res, url, deps);
  }
  if (url.includes('/sources')) {
    return handleSources(req, res, url, deps);
  }
  if (req.method !== 'POST') {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  const match = ROUTE.exec(url);
  if (!match) {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  const projectId = decodeURIComponent(match[1]);
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { ok: false, status: 400, error: { category: 'validation', message: 'invalid JSON body' } });
  }
  const result = await handleInvoke(deps.runtime as never, {
    actor,
    projectId,
    request: body as never,
  });
  return sendJson(res, result.status, result);
}

/** Authenticate via the canonical ActorAuthenticator; writes 401 and returns null on failure. */
async function resolveActor(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  deps: HttpApiDeps,
): Promise<string | null> {
  const token = bearerFromHeader(req.headers.authorization);
  try {
    const { actor } = await deps.authenticator.authenticate(token ?? '');
    return actor;
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      sendJson(res, 401, { ok: false, status: 401, error: { category: 'authorization', message: 'authentication required' } });
    } else {
      sendJson(res, 401, { ok: false, status: 401, error: { category: 'authorization', message: 'authentication required' } });
    }
    return null;
  }
}

async function handleSources(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: string,
  deps: HttpApiDeps,
): Promise<void> {
  if (!deps.sources) {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }

  // Pasted text: the original text becomes the raw artifact.
  const textMatch = /^\/v1\/projects\/([^/]+)\/sources\/text$/.exec(url);
  if (textMatch) {
    if (req.method !== 'POST') return notFound(res);
    const actor = await resolveActor(req, res, deps);
    if (!actor) return;
    const result = await handleCreateTextSource(deps.sources, decodeURIComponent(textMatch[1]), actor, await readJson(req).catch(() => ({})));
    return sendSourceResult(res, result);
  }

  // File upload: raw body + metadata headers, stored in PRIVATE storage.
  const fileMatch = /^\/v1\/projects\/([^/]+)\/sources\/file$/.exec(url);
  if (fileMatch) {
    if (req.method !== 'POST') return notFound(res);
    const actor = await resolveActor(req, res, deps);
    if (!actor) return;
    const decoded = (v: string | string[] | undefined) => (typeof v === 'string' ? decodeURIComponent(v) : undefined);
    const filename = decoded(req.headers['x-kip-filename']);
    if (!filename) return sendJson(res, 400, { ok: false, status: 400, error: { category: 'validation', message: 'x-kip-filename header is required' } });
    let bytes: Uint8Array;
    try {
      bytes = await readBinary(req);
    } catch {
      return sendJson(res, 400, { ok: false, status: 400, error: { category: 'validation', message: 'invalid or oversized upload' } });
    }
    const result = await handleCreateFileSource(deps.sources, decodeURIComponent(fileMatch[1]), actor, {
      bytes,
      filename,
      mimeType: (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream',
      title: decoded(req.headers['x-kip-title']),
      description: decoded(req.headers['x-kip-description']),
    });
    return sendSourceResult(res, result);
  }

  // Register an item selected from an external connection (github | google_drive).
  const providerMatch = /^\/v1\/projects\/([^/]+)\/sources\/(github|google_drive)$/.exec(url);
  if (providerMatch) {
    if (req.method !== 'POST') return notFound(res);
    if (!deps.connections) return notFound(res);
    const actor = await resolveActor(req, res, deps);
    if (!actor) return;
    const result = await handleRegisterExternalSource(
      deps.connections,
      decodeURIComponent(providerMatch[1]),
      providerMatch[2],
      actor,
      await readJson(req).catch(() => ({})),
    );
    return sendSourceResult(res, result);
  }

  const match = SOURCES_RE.exec(url);
  if (!match) {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  const projectId = decodeURIComponent(match[1]);
  const sourceId = match[2] ? decodeURIComponent(match[2]) : undefined;
  const actor = await resolveActor(req, res, deps);
  if (!actor) return;

  let result: import('./source-handler.ts').SourceApiResult;
  if (req.method === 'GET' && !sourceId) {
    result = await handleListSources(deps.sources, projectId, actor);
  } else if (req.method === 'POST' && !sourceId) {
    result = await handleCreateSource(deps.sources, projectId, actor, await readJson(req).catch(() => ({})));
  } else if (req.method === 'GET' && sourceId) {
    result = await handleGetSource(deps.sources, projectId, actor, sourceId);
  } else if (req.method === 'PATCH' && sourceId) {
    result = await handleUpdateSource(deps.sources, projectId, actor, sourceId, await readJson(req).catch(() => ({})));
  } else if (req.method === 'DELETE' && sourceId) {
    result = await handleArchiveSource(deps.sources, projectId, actor, sourceId);
  } else {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  return sendJson(res, result.status, {
    ok: result.ok,
    status: result.status,
    ...('data' in result && result.ok ? { data: result.data } : {}),
    ...('error' in result && !result.ok ? { error: result.error } : {}),
  } as ApiResult);
}

async function handleConnections(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: string,
  deps: HttpApiDeps,
): Promise<void> {
  if (!deps.connections) return notFound(res);

  const githubRoute = /^\/v1\/projects\/([^/]+)\/connections\/github(?:\/(start|repositories))?$/.exec(url);
  if (githubRoute) {
    if (!deps.github) {
      return sendJson(res, 400, { ok: false, status: 400, error: { category: 'validation', message: 'connector is not configured' } });
    }
    const actor = await resolveActor(req, res, deps);
    if (!actor) return;
    const projectId = decodeURIComponent(githubRoute[1]);
    const sub = githubRoute[2];
    if (sub === 'start' && req.method === 'POST') {
      return sendSourceResult(res, await handleGitHubStart(deps.github, projectId, actor));
    }
    if (sub === 'repositories' && req.method === 'GET') {
      return sendSourceResult(res, await handleGitHubRepositories(deps.github, projectId, actor));
    }
    if (!sub && req.method === 'DELETE') {
      return sendSourceResult(res, await handleGitHubDisconnect(deps.github, projectId, actor));
    }
    return notFound(res);
  }

  const listMatch = /^\/v1\/projects\/([^/]+)\/connections$/.exec(url);
  const itemsMatch = /^\/v1\/projects\/([^/]+)\/connections\/([^/]+)\/items$/.exec(url);
  if (!listMatch && !itemsMatch) return notFound(res);
  if (req.method !== 'GET') return notFound(res);

  const actor = await resolveActor(req, res, deps);
  if (!actor) return;
  if (listMatch) {
    return sendSourceResult(res, await handleListConnections(deps.connections, decodeURIComponent(listMatch[1]), actor));
  }
  return sendSourceResult(
    res,
    await handleListConnectionItems(
      deps.connections,
      decodeURIComponent(itemsMatch![1]),
      decodeURIComponent(itemsMatch![2]),
      actor,
    ),
  );
}

/** GitHub redirect endpoints: 302 back to the app with a non-sensitive indicator. */
async function handleProviderRedirect(
  res: import('node:http').ServerResponse,
  url: string,
  deps: HttpApiDeps,
): Promise<void> {
  const [path, qs = ''] = url.split('?');
  const isGitHub = path === '/v1/connections/github/callback' || path === '/v1/connections/github/setup';
  if (!isGitHub || !deps.github) {
    res.writeHead(302, { location: `${deps.github?.frontendUrl ?? ''}/knowledge#connector-unavailable` });
    res.end();
    return;
  }
  const { redirect } = await handleGitHubCallback(deps.github, new URLSearchParams(qs));
  res.writeHead(302, { location: redirect });
  res.end();
}

async function handleDocuments(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: string,
  deps: HttpApiDeps,
): Promise<void> {
  if (!deps.documents) return notFound(res);
  if (req.method !== 'GET') return notFound(res);

  const split = url.split('?');
  const path = split[0];
  const qs = split[1] ?? '';
  const bySource = new RegExp('^/v1/projects/([^/]+)/sources/([^/]+)/documents$').exec(path);
  const byId = new RegExp('^/v1/projects/([^/]+)/documents/([^/]+)$').exec(path);
  if (!bySource && !byId) return notFound(res);

  const actor = await resolveActor(req, res, deps);
  if (!actor) return;

  if (bySource) {
    const ingestionId = new URLSearchParams(qs).get('ingestionId') ?? undefined;
    return sendSourceResult(
      res,
      await handleListSourceDocuments(
        deps.documents,
        decodeURIComponent(bySource[1]),
        decodeURIComponent(bySource[2]),
        actor,
        ingestionId ?? undefined,
      ),
    );
  }
  return sendSourceResult(
    res,
    await handleGetDocument(deps.documents, decodeURIComponent(byId![1]), decodeURIComponent(byId![2]), actor),
  );
}

async function handleIngestions(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: string,
  deps: HttpApiDeps,
): Promise<void> {
  if (!deps.ingestion) return notFound(res);
  const sourceJobs = /^\/v1\/projects\/([^/]+)\/sources\/([^/]+)\/ingestions$/.exec(url);
  const projectJobs = /^\/v1\/projects\/([^/]+)\/ingestions$/.exec(url);
  const retryJob = /^\/v1\/projects\/([^/]+)\/ingestions\/([^/]+)\/retry$/.exec(url);
  const oneJob = /^\/v1\/projects\/([^/]+)\/ingestions\/([^/]+)$/.exec(url);

  const actor = await resolveActor(req, res, deps);
  if (!actor) return;

  if (sourceJobs) {
    const projectId = decodeURIComponent(sourceJobs[1]);
    const sourceId = decodeURIComponent(sourceJobs[2]);
    if (req.method === 'POST') {
      return sendSourceResult(res, await handleCreateIngestion(deps.ingestion, projectId, sourceId, actor));
    }
    if (req.method === 'GET') {
      return sendSourceResult(res, await handleListSourceIngestions(deps.ingestion, projectId, sourceId, actor));
    }
    return notFound(res);
  }
  if (projectJobs && req.method === 'GET') {
    return sendSourceResult(res, await handleListProjectIngestions(deps.ingestion, decodeURIComponent(projectJobs[1]), actor));
  }
  if (retryJob && req.method === 'POST') {
    return sendSourceResult(
      res,
      await handleRetryIngestion(deps.ingestion, decodeURIComponent(retryJob[1]), decodeURIComponent(retryJob[2]), actor),
    );
  }
  if (oneJob && req.method === 'GET') {
    return sendSourceResult(res, await handleGetIngestion(deps.ingestion, decodeURIComponent(oneJob[1]), decodeURIComponent(oneJob[2]), actor));
  }
  return notFound(res);
}

function notFound(res: import('node:http').ServerResponse): void {
  sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
}

/** Single response envelope for source + connection handler results. */
function sendSourceResult(
  res: import('node:http').ServerResponse,
  result: { ok: true; status: number; data: unknown } | { ok: false; status: number; error: { message: string; category: string } },
): void {
  const payload = result.ok
    ? ({ ok: true, status: result.status, data: result.data } as unknown as ApiResult)
    : ({ ok: false, status: result.status, error: result.error } as unknown as ApiResult);
  sendJson(res, result.status, payload);
}

/** Largest accepted raw upload — matches the private bucket's own limit. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function readBinary(req: import('node:http').IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function handleAdmin(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: string,
  deps: HttpApiDeps,
): Promise<void> {
  if (!deps.admin) {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  // Temporary bootstrap admin auth — constant-time check, not logged.
  const supplied = bearerFromHeader(req.headers.authorization);
  if (!isPlatformAdmin(supplied)) {
    return sendJson(res, 401, { ok: false, status: 401, error: { category: 'authorization', message: 'admin authentication required' } });
  }

  // Model Assignment control-plane routes first (different path shape).
  if (url.startsWith('/v1/admin/model-assignments')) {
    const aMatch = /^\/v1\/admin\/model-assignments(?:\/([^/]+))?$/.exec(url);
    if (!aMatch) {
      return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
    }
    const workloadKey = aMatch[1];
    let apiResponse: { ok: boolean; data?: unknown; error?: { message: string; category: string } };
    if (req.method === 'GET') {
      apiResponse = await listAssignments(deps.admin.adminApi);
    } else if (req.method === 'PUT' && workloadKey) {
      apiResponse = await putAssignment(deps.admin.adminApi, decodeURIComponent(workloadKey), await readJson(req).catch(() => ({})));
    } else if (req.method === 'DELETE' && workloadKey) {
      apiResponse = await deleteAssignment(deps.admin.adminApi, decodeURIComponent(workloadKey));
    } else {
      return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
    }
    return sendResult(res, apiResponse);
  }

  const ASSIGNMENT_RE = /^\/v1\/admin\/providers(?:\/([^/]+)(?:\/(test|revoke|models))?)?$/;
  const match = ASSIGNMENT_RE.exec(url);
  if (!match) {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  const providerKey = match[1] ?? 'openrouter';
  if (providerKey !== 'openrouter') {
    return sendJson(res, 400, { ok: false, status: 400, error: { category: 'validation', message: 'unknown provider' } });
  }

  let apiResponse;
  try {
    if (req.method === 'GET' && /\/models$/.test(url)) {
      apiResponse = await listProviderModels(deps.admin.adminApi);
    } else if (req.method === 'POST' && /\/test$/.test(url)) {
      apiResponse = await testConnection(deps.admin.adminApi, providerKey);
    } else if (req.method === 'POST' && /\/revoke$/.test(url)) {
      apiResponse = await revokeProvider(deps.admin.adminApi, providerKey);
    } else if (req.method === 'POST' && /\/providers(?:\/[^/]+)?$/.test(url)) {
      apiResponse = await connectProvider(deps.admin.adminApi, providerKey, await readJson(req).catch(() => ({})));
    } else if (req.method === 'GET' && /\/providers$/.test(url)) {
      apiResponse = await listProviders(deps.admin.adminApi);
    } else {
      return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
    }
    return sendResult(res, apiResponse);
  } catch (e) {
    return sendJson(res, 500, {
      ok: false,
      status: 500,
      error: { category: 'runtime', message: 'internal error' },
    });
  }
}

function sendResult(res: import('node:http').ServerResponse, apiResponse: { ok: boolean; data?: unknown; error?: { message: string; category: string } }): void {
  const status = apiResponse.ok ? 200 : 400;
  const payload: ApiResult = apiResponse.ok
    ? ({ ok: true, status, data: apiResponse.data } as unknown as ApiResult)
    : { ok: false, status, error: { category: (apiResponse.error?.category ?? 'runtime') as ErrorCategory, message: apiResponse.error?.message ?? 'error' } };
  sendJson(res, status, payload);
}

function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: import('node:http').ServerResponse, status: number, payload: ApiResult): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export { bearerFromHeader };