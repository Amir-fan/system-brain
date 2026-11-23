/**
 * @kip
 * @module vercel
 * @layer platform
 * @owner platform-infra
 * @feature K0-003
 * @purpose Bridge Vercel's Web Request contract to the canonical Node HTTP handler.
 */

import { Readable } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { HttpApiHandler } from '../api/http-server.ts';

function incomingHeaders(headers: Headers): IncomingHttpHeaders {
  const values: IncomingHttpHeaders = {};
  headers.forEach((value, name) => {
    values[name] = value;
  });
  return values;
}

function nodeRequest(request: Request): IncomingMessage {
  const body = request.body
    ? Readable.fromWeb(request.body as import('node:stream/web').ReadableStream)
    : Readable.from([]);
  const url = new URL(request.url);

  Object.defineProperties(body, {
    aborted: { get: () => request.signal.aborted },
    headers: { value: incomingHeaders(request.headers) },
    method: { value: request.method },
    url: { value: `${url.pathname}${url.search}`, writable: true },
  });
  return body as IncomingMessage;
}

interface CapturedResponse {
  response: ServerResponse;
  toWebResponse(): Response;
}

function capturedResponse(): CapturedResponse {
  const headers = new Headers();
  const chunks: Uint8Array[] = [];
  let statusCode = 200;
  let ended = false;
  let headersSent = false;

  const response = {
    get headersSent() { return headersSent; },
    get statusCode() { return statusCode; },
    set statusCode(value: number) { statusCode = value; },
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.delete(name);
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
      return response;
    },
    writeHead(code: number, values?: Record<string, number | string | readonly string[]>) {
      statusCode = code;
      for (const [name, value] of Object.entries(values ?? {})) response.setHeader(name, value);
      headersSent = true;
      return response;
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) {
        chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      }
      headersSent = true;
      ended = true;
      return response;
    },
  } as unknown as ServerResponse;

  return {
    response,
    toWebResponse() {
      if (!ended) throw new Error('KIP handler completed without ending the response');
      const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(body.byteLength > 0 ? body : null, { status: statusCode, headers });
    },
  };
}

export function createWebHandler(handler: HttpApiHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    const captured = capturedResponse();
    await handler(nodeRequest(request), captured.response);
    return captured.toWebResponse();
  };
}
