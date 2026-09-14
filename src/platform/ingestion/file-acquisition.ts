/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-011
 * @purpose File acquisition adapter: reads private raw storage (text formats only).
 *
 * Binary document formats (PDF/DOCX/PPTX) need real extraction and therefore
 * belong to a later slice - they fail explicitly instead of yielding garbage text.
 */

import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';
import type { AcquiredContent } from '../../core/ingestion/ingestion.types.ts';
import type { IngestionSourceReader, SourceAcquisitionAdapter } from '../../core/ingestion/ingestion.ports.ts';

/** Formats whose bytes are already text and can be decoded directly. */
export const TEXT_FILE_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml'] as const;

export function createFileAcquisitionAdapter(sources: IngestionSourceReader): SourceAcquisitionAdapter {
  return {
    sourceTypes: ['file'],
    async acquire({ projectId, sourceId }): Promise<AcquiredContent> {
      const raw = await sources.readRawMaterial(projectId, sourceId);
      if (!raw || raw.kind !== 'file' || !raw.bytes) throw new IngestionFailure('RAW_ARTIFACT_MISSING');

      const name = (raw.originalName ?? '').toLowerCase();
      const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
      if (!(TEXT_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
        // Explicit, safe failure: no fake extraction, no binary-as-text garbage.
        throw new IngestionFailure('ACQUISITION_FAILED', `unsupported file format: ${ext || 'unknown'}`);
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(raw.bytes);
      const originalName = raw.originalName ?? 'upload';
      return {
        sourceId,
        sourceType: 'file',
        contentType: 'text/plain',
        text,
        units: [
          {
            key: 'file:' + originalName,
            title: originalName,
            logicalPath: originalName,
            contentType: 'text/plain',
            text,
          },
        ],
        provenance: { kind: 'file', detail: ext, byteCount: raw.bytes.length },
      };
    },
  };
}
