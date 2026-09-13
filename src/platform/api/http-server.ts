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
import { actorFromToken } from './auth.ts';
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

export interface HttpApiDeps {
  runtime: Pick<import('../../core/runtime/runtime.service.ts').RuntimeService, 'execute'>;
  tokens: TokenActorMap;
  admin?: {
    storage: ProviderStorage;
    adminApi: AdminProviderApiDeps;
  };
}

const ROUTE = /^\/v1\/projects\/([^/]+)\/runs$/;
const ADMIN_ROUTE = /^\/v1\/admin\/providers(?:\/([^/]+)(?:\/(test|revoke|models))?)?$/;

export function createHttpApi(deps: HttpApiDeps): Server {
  return createServer(async (req, res) => {
    try {
      const url = req.url ?? '';
      if (url.startsWith('/v1/admin')) {
        return handleAdmin(req, res, url, deps);
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
  if (req.method !== 'POST') {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  const match = ROUTE.exec(url);
  if (!match) {
    return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
  }
  const projectId = decodeURIComponent(match[1]);
  const actor = actorFromToken(bearerFromHeader(req.headers.authorization), deps.tokens);
  if (!actor) {
    return sendJson(res, 401, { ok: false, status: 401, error: { category: 'authorization', message: 'authentication required' } });
  }
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