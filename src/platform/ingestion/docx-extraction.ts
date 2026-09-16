/**
 * @kip
 * @module ingestion
 * @layer platform
 * @owner platform-infra
 * @feature K17
 * @purpose Deterministic DOCX (OOXML) text extraction for knowledge ingestion.
 *
 * A DOCX is a ZIP of XML data ONLY. Nothing is ever executed: no macros, no OLE
 * objects, no embedded scripts, no external links. We read the main body part
 * (word/document.xml) and walk its fixed OOXML structure: paragraphs (<w:p>)
 * become lines, text runs (<w:t>) become their literal text. Arabic is stored as
 * real Unicode in OOXML, so it is preserved as-is.
 *
 * Text-run extraction is intentionally a narrow, targeted walk over the fixed
 * structure instead of a general XML parser — focused and verifiable.
 *
 * Resource safety (this is untrusted input): the caller bounds the file size and
 * this module bounds the entry count, the total uncompressed size and a per-entry
 * cap so a ZIP bomb cannot exhaust memory.
 */

import JSZip from 'jszip';
import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';

export const DOCX_LIMITS = {
  maxEntries: 5_000,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxSingleEntryBytes: 20 * 1024 * 1024,
} as const;

const MAIN_PART = 'word/document.xml';

export interface DocxExtraction {
  /** Deterministic body text: paragraphs in document order, joined by \n. */
  text: string;
  /** Number of non-empty paragraphs kept. */
  paragraphCount: number;
  chars: number;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Walk word/document.xml deterministically.
 * Paragraph boundaries come from <w:p>; each <w:t>…</w:t> is literal text.
 * Runs inside tables (<w:tc>) are ordinary paragraphs, so they are included.
 */
function bodyText(xml: string): string[] {
  const paragraphs: string[] = [];
  // Split on paragraph starts; the content of each paragraph is everything up to
  // the next <w:p. A paragraph ends with </w:p>, so slicing is safe.
  const parts = xml.split(/<w:p(?:\s[^>]*)?>/).slice(1);
  for (const raw of parts) {
    const body = raw.split('</w:p>')[0] ?? '';
    let text = '';
    for (const m of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) text += decodeEntities(m[1]);
    // A <w:tab/> is a literal tab stop; keep it as a single space.
    text = text.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

export async function extractDocx(bytes: Uint8Array): Promise<DocxExtraction> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch {
    throw new IngestionFailure('ACQUISITION_FAILED', 'invalid OOXML package (not a valid docx)');
  }

  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length === 0) throw new IngestionFailure('ACQUISITION_FAILED', 'empty OOXML package');
  if (entries.length > DOCX_LIMITS.maxEntries) {
    throw new IngestionFailure('ACQUISITION_FAILED', 'OOXML package has too many entries');
  }

  // Uncompressed size guard (ZIP-bomb defense).
  let total = 0;
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
    if (size > DOCX_LIMITS.maxSingleEntryBytes) {
      throw new IngestionFailure('ACQUISITION_FAILED', 'OOXML entry too large');
    }
    if (total > DOCX_LIMITS.maxUncompressedBytes) {
      throw new IngestionFailure('ACQUISITION_FAILED', 'OOXML archive expands beyond the safety limit');
    }
  }

  const main = zip.files[MAIN_PART];
  if (!main) throw new IngestionFailure('ACQUISITION_FAILED', 'no document body found in package');

  let xml: string;
  try {
    xml = await main.async('string');
  } catch {
    throw new IngestionFailure('ACQUISITION_FAILED', 'document body could not be read');
  }

  const paragraphs = bodyText(xml);
  const text = paragraphs.join('\n').trim();
  if (text.length === 0) {
    // A valid package with no readable text is not an extraction: never fabricate one.
    throw new IngestionFailure('ACQUISITION_FAILED', 'document body contains no text');
  }

  return { text, paragraphCount: paragraphs.length, chars: Array.from(text).length };
}
