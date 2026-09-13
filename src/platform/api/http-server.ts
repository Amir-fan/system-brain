/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Minimal Node-native HTTP listener for the single KIP API endpoint.
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { handleInvoke } from './api-handler.ts';
import { actorFromToken } from './auth.ts';
import type { TokenActorMap } from './auth.ts';
import type { ApiResult } from './api.types.ts';

export interface HttpApiDeps {
  runtime: Pick<import('../../core/runtime/runtime.service.ts').RuntimeService, 'execute'>;
  tokens: TokenActorMap;
}

const ROUTE = /^\/v1\/projects\/([^/]+)\/runs$/;

export function createHttpApi(deps: HttpApiDeps): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
      }
      const match = ROUTE.exec(req.url ?? '');
      if (!match) {
        return sendJson(res, 404, { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } });
      }
      const projectId = decodeURIComponent(match[1]);
      const token = bearerToken(req.headers.authorization);
      const actor = actorFromToken(token, deps.tokens);
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
    } catch {
      return sendJson(res, 500, { ok: false, status: 500, error: { category: 'runtime', message: 'internal error' } });
    }
  });
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : undefined;
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