/**
 * @kip
 * @module vercel
 * @layer platform
 * @owner platform-infra
 * @feature K0-003
 * @purpose Adapt Vercel's rewritten function URL to the canonical KIP Node handler.
 */

import type { HttpApiHandler } from '../api/http-server.ts';

const ROUTE_PARAMETER = '__kip_path';
const KIP_PATH = /^\/v1(?:\/[^?#\r\n]*)?$/;

export type HttpApiHandlerLoader = () => Promise<HttpApiHandler>;

function canonicalRequestUrl(requestUrl: string | undefined): string | null {
  const url = new URL(requestUrl ?? '/', 'http://kip.internal');
  const routedPaths = url.searchParams.getAll(ROUTE_PARAMETER);
  if (routedPaths.length !== 1 || !KIP_PATH.test(routedPaths[0])) return null;

  url.searchParams.delete(ROUTE_PARAMETER);
  const query = url.searchParams.toString();
  return `${routedPaths[0]}${query ? `?${query}` : ''}`;
}

function sendJson(
  response: Parameters<HttpApiHandler>[1],
  status: number,
  body: Record<string, unknown>,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export function createVercelHandler(loadHandler: HttpApiHandlerLoader): HttpApiHandler {
  let handlerPromise: Promise<HttpApiHandler> | undefined;

  const handler = () => {
    if (!handlerPromise) {
      handlerPromise = loadHandler().catch((error: unknown) => {
        handlerPromise = undefined;
        throw error;
      });
    }
    return handlerPromise;
  };

  return async (request, response) => {
    const requestUrl = canonicalRequestUrl(request.url);
    if (!requestUrl) {
      sendJson(response, 404, {
        ok: false,
        status: 404,
        error: { category: 'not_found', message: 'not found' },
      });
      return;
    }

    request.url = requestUrl;
    try {
      await (await handler())(request, response);
    } catch {
      sendJson(response, 500, {
        ok: false,
        status: 500,
        error: { category: 'runtime', message: 'internal error' },
      });
    }
  };
}
