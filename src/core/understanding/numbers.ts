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

/** Return the canonical date only for a whole ISO-style calendar value. */
export function normalizeIsoDate(value: string): string | undefined {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalizeDigits(value).trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(iso) ? iso : undefined;
}

/** Bounded numeric parse over normalized digits; undefined when there is no number. */
export function parseNumberLoose(input: string): number | undefined {
  const m = /-?\d+(?:\.\d+)?/.exec(normalizeDigits(input));
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

const WHOLE_CLOCK = /^(?:(at|في|الساعة|الساعه|كانت الساعة|كانت الساعه)\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*([ap]\.?m\.?|مساء|صباحا|صباحاً))?$/iu;

/** Normalize one complete, bounded clock expression to canonical 24-hour HH:mm. */
export function parseClockExpression(input: string): string | undefined {
  const match = WHOLE_CLOCK.exec(normalizeDigits(input).trim());
  if (!match) return undefined;
  const [, introduction, hours, minutes, period] = match;
  if (!introduction && !minutes && !period) return undefined;
  if (minutes !== undefined && Number(minutes) > 59) return undefined;
  let hour = Number(hours);
  if (hour > 23 || (period && (hour < 1 || hour > 12))) return undefined;
  if (period) hour = hour % 12 + (/^(?:p|مساء)/iu.test(period) ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${minutes ?? '00'}`;
}

/** A complete clock expression for an explicit correction. Bare numbers are not clock times. */
export function parseCorrectionClock(input: string): string | undefined {
  return parseClockExpression(input);
}
