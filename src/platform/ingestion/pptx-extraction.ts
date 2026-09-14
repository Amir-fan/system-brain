/**
 * @kip
 * @module ingestion
 * @layer platform
 * @owner platform-infra
 * @feature K1-006
 * @purpose Deterministic PPTX (OOXML) slide extraction for structured knowledge ingestion.
 *
 * A PPTX is a ZIP of XML data ONLY. Nothing is ever executed: no macros, no OLE
 * objects, no embedded scripts, no external links. We only read slide order and
 * text runs (a:t) per shape. Arabic text is preserved as-is (OOXML stores it as
 * Unicode). Text-run extraction is intentionally a narrow, targeted walk over the
 * fixed OOXML structure rather than a general XML parser — focused and verifiable.
 *
 * Resource safety (this is untrusted input): the caller bounds the file size and
 * this module bounds the entry count, the total uncompressed size and a per-entry
 * cap so a ZIP bomb cannot exhaust memory.
 */

import JSZip from 'jszip';
import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';

export const PPTX_LIMITS = {
  maxEntries: 5_000,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxSingleEntryBytes: 20 * 1024 * 1024,
  maxSlides: 2_000,
} as const;

export interface PptxSlide {
  number: number;
  /** Shape marked as a title placeholder, if any. */
  title: string;
  /** Deterministic text (a:t runs) in shape/paragraph order, paragraphs joined by \n. */
  text: string;
  chars: number;
}

export interface PptxExtraction {
  slides: PptxSlide[];
  slideCount: number;
  totalChars: number;
}

const A_T = '<a:t';

/**
 * Extract the text runs of one slide XML as one string with paragraph breaks.
 * Purely deterministic: we walk <a:t>…</a:t> and split paragraphs on <a:p>.
 */
function slideText(xml: string): string {
  // Paragraph split: record positions of <a:p ...> so text-runs between two
  // paragraphs join with "\n".
  const textRuns: Array<{ start: number; end: number; text: string }> = [];
  const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    textRuns.push({ start: m.index, end: re.lastIndex, text: m[1] });
  }
  // Paragraph boundaries: indexes into the runs array where a new <a:p> started.
  const paragraphBreaks = new Set<number>([0]);
  const apRe = /<a:p(?:\s[^>]*)?>/g;
  let pm: RegExpExecArray | null;
  while ((pm = apRe.exec(xml)) !== null) {
    const breakIndex = pm.index;
    const idx = textRuns.findIndex((t) => t.start >= breakIndex);
    if (idx >= 0) paragraphBreaks.add(idx);
  }
  const parts: string[] = [];
  for (let i = 0; i < textRuns.length; i++) {
    if (paragraphBreaks.has(i) && parts.length > 0) parts.push('');
    parts.push(textRuns[i].text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return parts.join('').split('\n').map((p) => p.trim()).join('\n').trim();
}

function hasTitlePlaceholder(xml: string): boolean {
  // A slide with any placeholder shape is treated as title-bearing (the default title
  // placeholder often carries no type attribute); the title is its first text line.
  return /<p:ph(?:\s[^>]*)?>/g.test(xml);
}

export async function extractPptx(bytes: Uint8Array): Promise<PptxExtraction> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch (e) {
    throw new IngestionFailure('ACQUISITION_FAILED', 'invalid OOXML package (not a valid pptx)');
  }

  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length === 0) throw new IngestionFailure('ACQUISITION_FAILED', 'empty OOXML package');
  if (entries.length > PPTX_LIMITS.maxEntries) {
    throw new IngestionFailure('ACQUISITION_FAILED', 'OOXML package has too many entries');
  }

  // Uncompressed size guard (ZIP-bomb defense).
  let total = 0;
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
    if (size > PPTX_LIMITS.maxSingleEntryBytes) {
      throw new IngestionFailure('ACQUISITION_FAILED', 'OOXML entry too large');
    }
    if (total > PPTX_LIMITS.maxUncompressedBytes) {
      throw new IngestionFailure('ACQUISITION_FAILED', 'OOXML archive expands beyond the safety limit');
    }
  }

  const slideNames = entries
    .map((e) => e.name)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slideNames.length === 0) throw new IngestionFailure('ACQUISITION_FAILED', 'no slides found in package');
  if (slideNames.length > PPTX_LIMITS.maxSlides) {
    throw new IngestionFailure('ACQUISITION_FAILED', 'presentation has too many slides');
  }

  const slides: PptxSlide[] = [];
  let totalChars = 0;
  for (const name of slideNames) {
    const number = slideNumber(name);
    const xml = await zip.files[name].async('string');
    const text = slideText(xml);
    const title = hasTitlePlaceholder(xml)
      ? slideText(xml).split('\n')[0] ?? ''
      : '';
    totalChars += text.length;
    slides.push({ number, title, text, chars: text.length });
  }

  return { slides, slideCount: slides.length, totalChars };
}

function slideNumber(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}