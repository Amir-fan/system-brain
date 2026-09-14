/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-ingestion
 * @feature K0-011
 * @purpose Deterministic text normalization (no LLM, no rewriting, no chunking).
 *
 * Turns raw material into valid, stable text: guaranteed-UTF-8, LF line endings,
 * collapsed blank-line runs, trimmed edges. Never rewrites user wording,
 * summarizes, classifies, translates, or chunks.
 */

import { createHash } from 'node:crypto';

export interface NormalizedText {
  text: string;
  /** Unicode code-point count (stable across JS string encodings). */
  charCount: number;
  sha256: string;
}

const BOM = '\uFEFF';
const REPLACEMENT = '\uFFFD';

/** Guarantee valid UTF-8 by round-tripping through the byte representation. */
function toValidUtf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeText(raw: string): NormalizedText {
  let text = typeof raw === 'string' ? raw : '';
  if (text.startsWith(BOM)) text = text.slice(BOM.length);
  text = toValidUtf8(text);

  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  if (text === REPLACEMENT) text = '';

  return {
    text,
    charCount: Array.from(text).length,
    sha256: sha256Hex(text),
  };
}
