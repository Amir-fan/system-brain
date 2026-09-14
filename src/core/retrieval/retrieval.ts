/**
 * @kip
 * @module retrieval
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-004
 * @purpose Provider-neutral retrieval: query -> candidate retrievers -> fusion -> evidence.
 *
 * Retrieval is a PLATFORM service. It knows nothing about any client domain, any
 * provider, or any knowledge vertical: it takes a query and filters, asks two
 * candidate retrievers (semantic + lexical) for a WIDE pool, fuses the rankings
 * deterministically, and returns ranked evidence. It never generates prose.
 *
 * Scores from different retrievers are never added: cosine similarity and lexical
 * rank are incomparable scales, so fusion is rank-based (Reciprocal Rank Fusion).
 */

export const SEMANTIC_CANDIDATES = 30;
export const LEXICAL_CANDIDATES = 30;
/** RRF damping constant from the original formulation. */
export const RRF_K = 60;
/**
 * Retriever weighting is AVAILABLE but NOT enabled: on the frozen gold set an
 * unweighted fusion scored best (Recall@8 90.5%) while a 1.0/0.5 semantic/lexical
 * weighting measured worse (85.7%), so the default stays unweighted.
 */
export const DEFAULT_TOP_K = 8;
export const MAX_TOP_K = 20;

/** Diversity: keep the evidence set useful, never dominated by one region. */
export const DIVERSITY_MAX_PER_DOCUMENT = 4;
export const DIVERSITY_NEAR_DUPLICATE = 0.9;
/** Below this token count, token overlap is too coarse to judge near-duplication. */
export const NEAR_DUPLICATE_MIN_TOKENS = 25;

export type RetrievalErrorCode =
  | 'RETRIEVAL_QUERY_EMPTY'
  | 'INDEX_MODEL_MISMATCH'
  | 'REINDEX_REQUIRED'
  | 'RETRIEVAL_FAILED';

export const RETRIEVAL_ERROR_MESSAGES: Record<RetrievalErrorCode, string> = {
  RETRIEVAL_QUERY_EMPTY: 'أدخل نصًا للبحث.',
  INDEX_MODEL_MISMATCH: 'نموذج الفهرسة الحالي لا يطابق النموذج المفهرس. يلزم إعادة الفهرسة.',
  REINDEX_REQUIRED: 'المعرفة غير مفهرسة بالكامل للنموذج الحالي. يلزم إعادة الفهرسة.',
  RETRIEVAL_FAILED: 'تعذر تنفيذ البحث.',
};

export class RetrievalFailure extends Error {
  readonly code: RetrievalErrorCode;
  constructor(code: RetrievalErrorCode, detail?: string) {
    super(RETRIEVAL_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'RetrievalFailure';
    if (detail) this.stack = `${this.stack ?? ''}\n[cause] ${detail}`;
  }
}

export interface RetrievalFilters {
  sourceIds?: string[];
  documentIds?: string[];
}

export interface CandidateChunk {
  chunkId: string;
  documentId: string;
  sourceId: string;
  logicalPath?: string;
  headingContext?: string;
  text: string;
  contentSha256: string;
  score: number;
}

/** Per-result retrieval signals. Rank-based and additive-free: no opaque math. */
export interface RetrievalSignals {
  semanticRank?: number;
  semanticScore?: number;
  lexicalRank?: number;
  lexicalScore?: number;
  fusedScore: number;
  /** Which retrievers actually returned this chunk. */
  foundBy: string[];
  /** True when the final pass kept this chunk as the strongest of its document region. */
  diverse: boolean;
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  sourceId: string;
  logicalPath?: string;
  headingContext?: string;
  text: string;
  score: number;
  retrievalSignals: RetrievalSignals;
  /** Present only when logical path looks like an Arabic or code artifact; safe display fields. */
  contentType?: string;
}

/**
 * Confidence information for a LATER consumer (K16) to decide INSUFFICIENT_EVIDENCE.
 * Deliberately descriptive: no invented universal threshold, just the measurements.
 */
export interface RetrievalConfidence {
  resultCount: number;
  topFusedScore: number;
  topSemanticScore: number | null;
  topLexicalScore: number | null;
  /** Fraction of the final set that BOTH retrievers agreed on. */
  agreement: number;
  /** True when the strongest evidence came from one retriever only. */
  singleRetrieverEvidence: boolean;
}

export interface VectorRetrieverPort {
  vectorSearch(input: {
    projectId: string;
    modelId: string;
    queryVector: number[];
    limit: number;
    filters: RetrievalFilters;
  }): Promise<CandidateChunk[]>;
}

export interface LexicalRetrieverPort {
  lexicalSearch(input: {
    projectId: string;
    query: string;
    limit: number;
    filters: RetrievalFilters;
  }): Promise<CandidateChunk[]>;
}

/** Index readiness facts the service needs before it may compare vectors. */
export interface RetrievalIndexReader {
  /** The model the stored vectors were produced with (null when nothing is indexed). */
  indexedModelId(projectId: string): Promise<string | null>;
}

export interface FusedCandidate {
  chunk: CandidateChunk;
  fusedScore: number;
  semanticRank?: number;
  semanticScore?: number;
  lexicalRank?: number;
  lexicalScore?: number;
}

/**
 * Reciprocal Rank Fusion over rankings (not scores): score = Σ 1 / (k + rank).
 * Deterministic tie-breaking by chunk id keeps results stable across runs.
 */
export function reciprocalRankFusion(
  rankings: Array<{ name: string; items: CandidateChunk[]; weight?: number }>,
  k: number = RRF_K,
): FusedCandidate[] {
  const fused = new Map<string, FusedCandidate>();

  for (const ranking of rankings) {
    ranking.items.forEach((chunk, index) => {
      const rank = index + 1;
      const existing = fused.get(chunk.chunkId);
      // Weighting exists because the retrievers are NOT equally strong: on the
      // frozen gold set lexical-only recall is far below semantic recall, so an
      // unweighted fusion lets a weak lexical hit demote a strong semantic one.
      const contribution = (ranking.weight ?? 1) / (k + rank);
      if (!existing) {
        fused.set(chunk.chunkId, {
          chunk,
          fusedScore: contribution,
          ...(ranking.name === 'semantic'
            ? { semanticRank: rank, semanticScore: chunk.score }
            : { lexicalRank: rank, lexicalScore: chunk.score }),
        });
        return;
      }
      existing.fusedScore += contribution;
      if (ranking.name === 'semantic') {
        existing.semanticRank = rank;
        existing.semanticScore = chunk.score;
      } else {
        existing.lexicalRank = rank;
        existing.lexicalScore = chunk.score;
      }
    });
  }

  return [...fused.values()].sort(
    (a, b) => b.fusedScore - a.fusedScore || a.chunk.chunkId.localeCompare(b.chunk.chunkId),
  );
}

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length > 1),
  );

/** Deterministic Jaccard overlap — cheap near-duplicate detection without a round trip. */
export function tokenOverlap(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Diversity pass, in fused order:
 *   1. exact duplicate content hashes are suppressed (keep the strongest),
 *   2. a document may contribute at most `maxPerDocument` chunks,
 *   3. a chunk that near-duplicates an already selected chunk OF THE SAME DOCUMENT
 *      is suppressed (overlapping regions of one document).
 * Multiple documents and sources remain welcome: this removes redundancy, not breadth.
 */
export function diversify(
  fused: FusedCandidate[],
  limit: number,
  maxPerDocument: number = DIVERSITY_MAX_PER_DOCUMENT,
  nearDuplicate: number = DIVERSITY_NEAR_DUPLICATE,
): Array<{ candidate: FusedCandidate; diverse: boolean }> {
  const seenHashes = new Set<string>();
  const perDocument = new Map<string, number>();
  const selected: Array<{ candidate: FusedCandidate; diverse: boolean }> = [];

  for (const candidate of fused) {
    if (selected.length >= limit) break;
    const { chunk } = candidate;
    if (seenHashes.has(chunk.contentSha256)) continue;

    const used = perDocument.get(chunk.documentId) ?? 0;
    if (used >= maxPerDocument) continue;

    // Near-duplicate detection only applies to chunk-sized text: on very short
    // strings a handful of shared words pushes Jaccard to 1, which would suppress
    // genuinely different short evidence. Identical short text is already caught by
    // the exact content hash above.
    const tokens = tokenize(chunk.text);
    const redundant =
      tokens.size >= NEAR_DUPLICATE_MIN_TOKENS &&
      selected.some(
        (kept) =>
          kept.candidate.chunk.documentId === chunk.documentId &&
          tokenOverlap(kept.candidate.chunk.text, chunk.text) >= nearDuplicate,
      );
    if (redundant) continue;

    seenHashes.add(chunk.contentSha256);
    perDocument.set(chunk.documentId, used + 1);
    selected.push({ candidate, diverse: true });
  }

  return selected;
}

export function confidenceOf(results: RetrievalResult[]): RetrievalConfidence {
  const top = results[0];
  const agreed = results.filter((r) => r.retrievalSignals.foundBy.length > 1).length;
  return {
    resultCount: results.length,
    topFusedScore: top?.retrievalSignals.fusedScore ?? 0,
    topSemanticScore: top?.retrievalSignals.semanticScore ?? null,
    topLexicalScore: top?.retrievalSignals.lexicalScore ?? null,
    agreement: results.length === 0 ? 0 : agreed / results.length,
    singleRetrieverEvidence: Boolean(top) && (top.retrievalSignals.foundBy.length === 1),
  };
}
