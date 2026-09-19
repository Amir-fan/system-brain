/**
 * @kip
 * @module understanding
 * @layer core
 * @owner platform-core
 * @feature K26-A
 * @purpose Deterministic digit normalization: Arabic-Indic and Extended Arabic-Indic
 * digits must mean the same thing as ASCII digits. Not a localization framework.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** ٠١٢٣٤٥٦٧٨٩ / ۰۱۲۳۴۵۶۷۸۹ → 0123456789 */
export function normalizeDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EXTENDED_ARABIC_INDIC.indexOf(ch);
    out += a >= 0 ? String(a) : e >= 0 ? String(e) : ch;
  }
  return out;
}

/** Bounded numeric parse over normalized digits; undefined when there is no number. */
export function parseNumberLoose(input: string): number | undefined {
  const m = /-?\d+(?:\.\d+)?/.exec(normalizeDigits(input));
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}
