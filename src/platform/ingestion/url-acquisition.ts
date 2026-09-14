/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-012
 * @purpose URL acquisition adapter: one registered URL -> one fetched resource.
 *
 * Server-side fetch only, SSRF-guarded, size- and time-bounded, redirects
 * followed manually so every hop is re-validated. No crawling, no JS rendering,
 * no LLM. HTML is reduced to text deterministically.
 */

import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';
import type { AcquiredContent } from '../../core/ingestion/ingestion.types.ts';
import type { IngestionSourceReader, SourceAcquisitionAdapter } from '../../core/ingestion/ingestion.ports.ts';
import { assertUrlAllowed } from './url-safety.ts';
import type { UrlSafetyDeps } from './url-safety.ts';
import { htmlToText } from './html-to-text.ts';

export const URL_ACQUISITION_LIMITS = {
  maxBytes: 2_000_000,
  timeoutMs: 10_000,
  maxRedirects: 5,
} as const;

/** Content types K11 can turn into text deterministically. */
export const TEXTUAL_CONTENT_TYPES = [
  'text/plain',
  'text/html',
  'text/markdown',
  'text/x-markdown',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/json',
  'text/csv',
] as const;

export interface UrlAcquisitionDeps extends UrlSafetyDeps {
  sources: IngestionSourceReader;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new IngestionFailure('URL_TOO_LARGE');

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new IngestionFailure('URL_TOO_LARGE');
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* stream already closing */
      }
      throw new IngestionFailure('URL_TOO_LARGE');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function createUrlAcquisitionAdapter(deps: UrlAcquisitionDeps): SourceAcquisitionAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? URL_ACQUISITION_LIMITS.maxBytes;
  const timeoutMs = deps.timeoutMs ?? URL_ACQUISITION_LIMITS.timeoutMs;
  const maxRedirects = deps.maxRedirects ?? URL_ACQUISITION_LIMITS.maxRedirects;

  return {
    sourceTypes: ['url'],
    async acquire({ projectId, sourceId }): Promise<AcquiredContent> {
      const source = await deps.sources.getSource(projectId, sourceId);
      const registered = source?.externalUri ?? '';
      if (!registered) throw new IngestionFailure('URL_INVALID');

      let current = await assertUrlAllowed(registered, deps);
      let response: Response | null = null;

      for (let hop = 0; hop <= maxRedirects; hop++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res: Response;
        try {
          res = await fetchImpl(current.toString(), {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              accept: 'text/html,text/plain;q=0.9,text/markdown;q=0.8,application/json;q=0.5,*/*;q=0.1',
              'user-agent': 'kip-next/1.0 (knowledge intake)',
            },
          });
        } catch {
          throw new IngestionFailure('URL_FETCH_FAILED');
        } finally {
          clearTimeout(timer);
        }

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) throw new IngestionFailure('URL_FETCH_FAILED');
          // Each hop is re-validated: a redirect must not smuggle us inward.
          current = await assertUrlAllowed(new URL(location, current).toString(), deps);
          continue;
        }
        response = res;
        break;
      }

      if (!response) throw new IngestionFailure('URL_FETCH_FAILED');
      if (!response.ok) throw new IngestionFailure('URL_FETCH_FAILED');

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!(TEXTUAL_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        throw new IngestionFailure('URL_UNSUPPORTED_CONTENT_TYPE');
      }

      const bytes = await readCapped(response, maxBytes);
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const looksHtml = contentType.includes('html') || /^\s*<(?:!doctype|html)/i.test(decoded);
      const extracted = looksHtml ? htmlToText(decoded) : { title: undefined, text: decoded };
      const text = extracted.text;

      return {
        sourceId,
        sourceType: 'url',
        contentType: 'text/plain',
        text,
        units: [
          {
            key: 'url:primary',
            ...(extracted.title ? { title: extracted.title } : {}),
            logicalPath: current.hostname,
            contentType: 'text/plain',
            text,
          },
        ],
        provenance: { kind: 'url', detail: current.hostname, byteCount: bytes.length },
      };
    },
  };
}
