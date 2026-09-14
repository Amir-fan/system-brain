/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-002
 * @purpose Canonical chunking: deterministic, ordered segments of ONE document.
 *
 * A Chunk is not a source, artifact, job, document, or embedding. V1 chunking is
 * deterministic text segmentation (no LLM, no semantic splitting): it prefers
 * paragraph and heading boundaries, falls back to sentence/line boundaries, and
 * hard-splits only as a last resort. Chunks never cross document boundaries.
 */

import { createHash } from 'node:crypto';

export const CHUNKING_CONFIG = {
  /** Preferred chunk size; grouping stops when the next paragraph would exceed it. */
  targetChars: 1500,
  /** Hard ceiling: a single oversized paragraph is split before this. */
  maxChars: 1800,
  /** Small deterministic overlap so sentences spanning a boundary stay readable. */
  overlapChars: 200,
} as const;

export interface ChunkUnit {
  index: number;
  key: string;
  text: string;
  sha256: string;
  charCount: number;
  startChar: number;
  endChar: number;
  headingContext?: string;
}

export interface ChunkRecord extends ChunkUnit {
  id: string;
  projectId: string;
  documentId: string;
  sourceId: string;
  ingestionJobId: string;
  logicalPath?: string;
  createdAt: string;
}

export interface ChunkSummary {
  id: string;
  documentId: string;
  sourceId: string;
  chunkIndex: number;
  chunkKey: string;
  charCount: number;
  contentSha256: string;
  headingContext?: string;
  logicalPath?: string;
  preview: string;
}

export interface CreateChunkInput {
  projectId: string;
  documentId: string;
  sourceId: string;
  ingestionJobId: string;
  chunkIndex: number;
  chunkKey: string;
  textContent: string;
  contentSha256: string;
  charCount: number;
  startChar: number;
  endChar: number;
  headingContext?: string;
  logicalPath?: string;
}

export interface ChunkPersistence {
  saveChunks(inputs: CreateChunkInput[]): Promise<ChunkRecord[]>;
  deleteChunksForJob(ingestionJobId: string): Promise<void>;
  listChunkSummaries(projectId: string, documentId: string): Promise<ChunkSummary[]>;
  getChunk(projectId: string, chunkId: string): Promise<ChunkRecord | null>;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const chunkKeyOf = (documentKey: string, index: number) =>
  documentKey + '#' + String(index).padStart(4, '0');

const HEADING = /^(#{1,6})\s+(.*)$/;
const SENTENCE_END = /[.!?؟]\s|\n/g;

interface Segment {
  start: number;
  end: number;
  text: string;
  headingContext?: string;
}

/** Contiguous paragraph spans (no gaps), with markdown heading context tracked. */
function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let cursor = 0;

  for (const raw of text.split('\n\n')) {
    const start = cursor;
    const end = cursor + raw.length;
    cursor = end + 2;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      segments.push({ start, end, text: raw, headingContext: stack.map((h) => h.title).join(' > ') });
      continue;
    }
    const ctx = stack.map((h) => h.title).join(' > ');
    segments.push({ start, end, text: raw, ...(ctx ? { headingContext: ctx } : {}) });
  }
  return segments;
}

/** Split an oversized segment at sentence/line boundaries, hard-splitting only if needed. */
function splitOversized(seg: Segment, maxChars: number): Segment[] {
  if (seg.text.length <= maxChars) return [seg];
  const parts: Segment[] = [];
  const body = seg.text;
  let offset = 0;
  while (offset < body.length) {
    const remaining = body.length - offset;
    if (remaining <= maxChars) {
      parts.push({
        start: seg.start + offset,
        end: seg.end,
        text: body.slice(offset),
        ...(seg.headingContext ? { headingContext: seg.headingContext } : {}),
      });
      break;
    }
    const window = body.slice(offset, offset + maxChars);
    let cut = -1;
    SENTENCE_END.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END.exec(window)) !== null) cut = m.index + 1;
    const size = cut > maxChars * 0.4 ? cut : maxChars;
    parts.push({
      start: seg.start + offset,
      end: seg.start + offset + size,
      text: body.slice(offset, offset + size),
      ...(seg.headingContext ? { headingContext: seg.headingContext } : {}),
    });
    offset += size;
  }
  return parts;
}

/**
 * Deterministic document -> chunks. Chunks are contiguous with a bounded overlap,
 * never empty, never crossing a boundary, and stable for identical input.
 */
export function chunkDocument(
  text: string,
  documentKey: string,
  config: typeof CHUNKING_CONFIG = CHUNKING_CONFIG,
): ChunkUnit[] {
  const source = typeof text === 'string' ? text : '';
  if (source.trim().length === 0) return [];

  const segments = segment(source).flatMap((s) => splitOversized(s, config.maxChars));
  if (segments.length === 0) return [];

  const chunks: ChunkUnit[] = [];
  let groupStart = segments[0].start;
  let groupEnd = segments[0].end;
  let heading: string | undefined = segments[0].headingContext;

  const push = (coreStart: number, coreEnd: number, headingContext?: string) => {
    const start = chunks.length === 0 ? coreStart : Math.max(0, coreStart - config.overlapChars);
    const slice = source.slice(start, coreEnd);
    if (slice.trim().length === 0) return;
    const index = chunks.length;
    chunks.push({
      index,
      key: chunkKeyOf(documentKey, index),
      text: slice,
      sha256: sha256(slice),
      charCount: slice.length,
      startChar: start,
      endChar: coreEnd,
      ...(headingContext ? { headingContext } : {}),
    });
  };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    if (next.end - groupStart > config.targetChars) {
      push(groupStart, groupEnd, heading);
      groupStart = next.start;
      groupEnd = next.end;
      heading = next.headingContext;
      continue;
    }
    groupEnd = next.end;
    if (next.headingContext && next.headingContext !== heading) heading = next.headingContext;
  }
  push(groupStart, groupEnd, heading);
  return chunks;
}
