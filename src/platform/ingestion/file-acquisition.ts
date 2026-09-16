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
import { extractPptx } from '../ingestion/pptx-extraction.ts';
import { extractDocx } from '../ingestion/docx-extraction.ts';
import type { AcquiredContent } from '../../core/ingestion/ingestion.types.ts';
import type { IngestionSourceReader, SourceAcquisitionAdapter } from '../../core/ingestion/ingestion.ports.ts';

/** Formats whose bytes are already text and can be decoded directly. */
export const TEXT_FILE_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'json', 'log', 'yaml', 'yml'] as const;

/**
 * Decode a plain-text file. Honours a UTF-16 BOM (LE/BE) and otherwise reads
 * UTF-8, stripping a leading BOM. `fatal: false` means invalid bytes become the
 * replacement char instead of throwing — never a decode crash on user content.
 */
function decodeTextFile(bytes: Uint8Array): string {
  const b = bytes;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(b);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function createFileAcquisitionAdapter(sources: IngestionSourceReader): SourceAcquisitionAdapter {
  return {
    sourceTypes: ['file'],
    async acquire({ projectId, sourceId }): Promise<AcquiredContent> {
      const raw = await sources.readRawMaterial(projectId, sourceId);
      if (!raw || raw.kind !== 'file' || !raw.bytes) throw new IngestionFailure('RAW_ARTIFACT_MISSING');

      const name = (raw.originalName ?? '').toLowerCase();
      const ext = name.includes('.') ? name.split('.').pop() ?? '' : '';
      // Structured knowledge: Pptx is an OOXML data archive. Each slide becomes one
      // canonical document with slide provenance (logicalPath = "الشريحة N").
      if (ext === 'pptx') {
        const extraction = await extractPptx(raw.bytes);
        return {
          sourceId,
          sourceType: 'file',
          contentType: 'text/plain',
          text: '',
          units: extraction.slides.map((slide) => ({
            key: 'slide:' + String(slide.number),
            title: slide.title || 'الشريحة ' + slide.number,
            logicalPath: 'الشريحة ' + slide.number,
            contentType: 'text/plain',
            text: slide.text,
          })),
          provenance: { kind: 'file', detail: 'pptx', byteCount: raw.bytes.length },
        };
      }
      if (ext === 'docx') {
        // Word OOXML: the document body becomes ONE canonical document whose text
        // is the real paragraph content (never a paraphrase, never blank).
        const extraction = await extractDocx(raw.bytes);
        return {
          sourceId,
          sourceType: 'file',
          contentType: 'text/plain',
          text: extraction.text,
          units: [
            {
              key: 'file:' + (raw.originalName ?? 'document.docx'),
              title: raw.originalName ?? 'document.docx',
              logicalPath: raw.originalName ?? 'document.docx',
              contentType: 'text/plain',
              text: extraction.text,
            },
          ],
          provenance: { kind: 'file', detail: 'docx', byteCount: raw.bytes.length },
        };
      }
      if (ext === 'pdf' || (raw.bytes[0] === 0x25 && raw.bytes[1] === 0x50 && raw.bytes[2] === 0x44)) {
        // Scanned/image-only PDF: no usable text layer. Explicit, retryable
        // requirement — never a generic failure, never binary-as-text garbage.
        throw new IngestionFailure('OCR_REQUIRED', 'pdf without a usable text layer');
      }
      if (!(TEXT_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
        // Explicit, safe failure: no fake extraction, no binary-as-text garbage.
        throw new IngestionFailure('ACQUISITION_FAILED', `unsupported file format: ${ext || 'unknown'}`);
      }
      const text = decodeTextFile(raw.bytes);
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
