/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-012
 * @purpose Deterministic HTML -> readable text extraction (no LLM, no DOM library).
 *
 * Removes non-content elements, keeps title/headings/paragraphs/list items as
 * plain lines, and decodes common entities. It never summarizes, rewrites, or
 * manufactures content, and it does not attempt to render JavaScript.
 * Static regex literals are used deliberately: they are easy to read, easy to
 * test, and immune to escaping mistakes in dynamically built patterns.
 */

/** Elements whose entire contents are not knowledge content. */
const NON_CONTENT_BLOCKS = /<(script|style|noscript|svg|template|iframe|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Any leftover opening/closing tag of those elements. */
const NON_CONTENT_TAGS = /<\/?(?:script|style|noscript|svg|template|iframe|head)\b[^>]*>/gi;
/** Block-level boundaries become newlines. */
const BLOCK_TAGS = /<\/?(?:p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tbody|thead|tr|td|th|blockquote|pre|figure|figcaption|form|h[1-6]|br|hr)\b[^>]*>/gi;
/** List items become explicit bullet lines. */
const LIST_ITEMS = /<li\b[^>]*>/gi;
/** Anything still tag-shaped is dropped. */
const ANY_TAG = /<[^>]*>/g;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

const NAMED_ENTITY = /&[a-zA-Z]+;/g;

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(NAMED_ENTITY, (m) => ENTITIES[m] ?? m);
}

export interface ExtractedHtml {
  title?: string;
  text: string;
}

export function htmlToText(html: string): ExtractedHtml {
  let body = html ?? '';
  if (body.startsWith('\uFEFF')) body = body.slice(1);

  // Title is captured before <head> is discarded.
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : undefined;

  body = body.replace(/<!--[\s\S]*?-->/g, '');
  body = body.replace(NON_CONTENT_BLOCKS, ' ');
  body = body.replace(NON_CONTENT_TAGS, ' ');
  body = body.replace(LIST_ITEMS, '\n- ');
  body = body.replace(BLOCK_TAGS, '\n');
  body = body.replace(ANY_TAG, ' ');

  body = decodeEntities(body)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: title ? `${title}\n\n${body}`.trim() : body };
}
