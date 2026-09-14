/**
 * @kip
 * @module project
 * @layer core
 * @owner platform-core
 * @feature K0-011
 * @purpose Canonical source-type vocabulary shared by Source Registry and Ingestion.
 */

export const SOURCE_TYPES = ['url', 'file', 'text', 'github', 'google_drive'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export function isSourceType(v: unknown): v is SourceType {
  return typeof v === 'string' && (SOURCE_TYPES as readonly string[]).includes(v);
}
