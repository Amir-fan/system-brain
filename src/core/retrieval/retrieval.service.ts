/**
 * @kip
 * @module retrieval
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-004
 * @purpose Retrieval orchestration: query -> candidates -> fusion -> ranked evidence.
 *
 * Two candidate retrievers run CONCURRENTLY (they are independent reads), then the
 * rankings are fused. Every stage is timed so latency is attributable, and every
 * guard is explicit: a query is never compared against vectors produced by a
 * different model, and nothing here writes prose or answers questions.
 */

import {
  DEFAULT_TOP_K,
  LEXICAL_CANDIDATES,
  MAX_TOP_K,
  RetrievalFailure,
  SEMANTIC_CANDIDATES,
  confidenceOf,
  diversify,
  reciprocalRankFusion,
} from './retrieval.ts';
import { EMBEDDING_DIMENSIONS } from '../embedding/embedding.ts';
import type {
  LexicalRetrieverPort,
  RetrievalConfidence,
  RetrievalFilters,
  RetrievalIndexReader,
  RetrievalResult,
  VectorRetrieverPort,
} from './retrieval.ts';
import type { ModelGateway } from '../model-gateway/model-gateway.ts';
import type { ModelAssignmentResolver } from '../../platform/provider/model-assignment.ts';

export interface RetrievalTimings {
  queryEmbeddingMs: number;
  vectorSearchMs: number;
  lexicalSearchMs: number;
  fusionMs: number;
  totalMs: number;
}

export interface RetrievalObservation {
  event: 'retrieval.completed' | 'retrieval.failed';
  projectId: string;
  modelId?: string;
  resultCount?: number;
  semanticCandidates?: number;
  lexicalCandidates?: number;
  topFusedScore?: number;
  agreement?: number;
  timings: RetrievalTimings;
  errorCode?: string;
}

export interface RetrievalServiceDeps {
  vector: VectorRetrieverPort;
  lexical: LexicalRetrieverPort;
  index: RetrievalIndexReader;
  resolver: ModelAssignmentResolver;
  gateway: ModelGateway;
  onObservation?: (observation: RetrievalObservation) => void;
}

export interface SearchInput {
  projectId: string;
  query: string;
  topK?: number;
  filters?: RetrievalFilters;
}

export interface SearchOutcome {
  query: string;
  results: RetrievalResult[];
  confidence: RetrievalConfidence;
  timings: RetrievalTimings;
  modelId: string;
  candidates: { semantic: number; lexical: number };
  /** Best RAW score from each retriever — the measure the K15 confidence floor was
   *  calibrated on. The fused top-1 can hide a strong semantic hit behind a lexical
   *  winner, which would starve the sufficiency gate of its best signal. */
  rawBest: { semantic: number | null; lexical: number | null };
}

export class RetrievalService {
  constructor(private readonly deps: RetrievalServiceDeps) {}

  async search(input: SearchInput): Promise<SearchOutcome> {
    const startedMs = Date.now();
    const timings: RetrievalTimings = {
      queryEmbeddingMs: 0,
      vectorSearchMs: 0,
      lexicalSearchMs: 0,
      fusionMs: 0,
      totalMs: 0,
    };
    const query = (input.query ?? '').trim();
    if (query.length === 0) throw new RetrievalFailure('RETRIEVAL_QUERY_EMPTY');

    const topK = Math.min(Math.max(input.topK ?? DEFAULT_TOP_K, 1), MAX_TOP_K);
    const filters = input.filters ?? {};

    // Guard: query vectors must come from the SAME model as the stored vectors.
    let modelId: string;
    try {
      const resolved = await this.deps.resolver.resolve({ profile: 'embeddings' });
      modelId = resolved.modelId;
    } catch {
      throw new RetrievalFailure('INDEX_MODEL_MISMATCH');
    }
    const indexedModel = await this.deps.index.indexedModelId(input.projectId);
    if (!indexedModel) throw new RetrievalFailure('REINDEX_REQUIRED');
    if (indexedModel !== modelId) throw new RetrievalFailure('INDEX_MODEL_MISMATCH');

    // 1. Query embedding (provider query semantics).
    const embedStart = Date.now();
    const embedded = await this.deps.gateway.embedTexts({
      projectId: input.projectId,
      runId: `retrieval:${startedMs}`,
      modelId,
      texts: [query],
      inputType: 'query',
      dimensions: EMBEDDING_DIMENSIONS,
    });
    timings.queryEmbeddingMs = Date.now() - embedStart;
    const queryVector = embedded.vectors[0];
    if (!Array.isArray(queryVector) || queryVector.length !== EMBEDDING_DIMENSIONS) {
      throw new RetrievalFailure('INDEX_MODEL_MISMATCH', 'query vector width');
    }

    // 2. Independent reads, concurrently.
    const vectorStart = Date.now();
    const lexicalStart = Date.now();
    const [semantic, lexical] = await Promise.all([
      this.deps.vector
        .vectorSearch({
          projectId: input.projectId,
          modelId,
          queryVector,
          limit: SEMANTIC_CANDIDATES,
          filters,
        })
        .then((rows) => {
          timings.vectorSearchMs = Date.now() - vectorStart;
          return rows;
        }),
      this.deps.lexical
        .lexicalSearch({ projectId: input.projectId, query, limit: LEXICAL_CANDIDATES, filters })
        .then((rows) => {
          timings.lexicalSearchMs = Date.now() - lexicalStart;
          return rows;
        }),
    ]);

    // 3. Rank fusion (never score addition) + diversity.
    const fusionStart = Date.now();
    const fused = reciprocalRankFusion([
      { name: 'semantic', items: semantic },
      { name: 'lexical', items: lexical },
    ]);
    const selected = diversify(fused, topK);
    timings.fusionMs = Date.now() - fusionStart;

    const results: RetrievalResult[] = selected.map(({ candidate, diverse }) => {
      const { chunk } = candidate;
      const foundBy: string[] = [];
      if (candidate.semanticRank !== undefined) foundBy.push('semantic');
      if (candidate.lexicalRank !== undefined) foundBy.push('lexical');
      return {
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        sourceId: chunk.sourceId,
        ...(chunk.logicalPath ? { logicalPath: chunk.logicalPath } : {}),
        ...(chunk.headingContext ? { headingContext: chunk.headingContext } : {}),
        text: chunk.text,
        score: candidate.fusedScore,
        retrievalSignals: {
          ...(candidate.semanticRank !== undefined ? { semanticRank: candidate.semanticRank } : {}),
          ...(candidate.semanticScore !== undefined ? { semanticScore: candidate.semanticScore } : {}),
          ...(candidate.lexicalRank !== undefined ? { lexicalRank: candidate.lexicalRank } : {}),
          ...(candidate.lexicalScore !== undefined ? { lexicalScore: candidate.lexicalScore } : {}),
          fusedScore: candidate.fusedScore,
          foundBy,
          diverse,
        },
      };
    });

    timings.totalMs = Date.now() - startedMs;
    const confidence = confidenceOf(results);

    this.deps.onObservation?.({
      event: 'retrieval.completed',
      projectId: input.projectId,
      modelId,
      resultCount: results.length,
      semanticCandidates: semantic.length,
      lexicalCandidates: lexical.length,
      topFusedScore: confidence.topFusedScore,
      agreement: confidence.agreement,
      timings,
    });

    return {
      query,
      results,
      confidence,
      timings,
      modelId,
      candidates: { semantic: semantic.length, lexical: lexical.length },
      rawBest: {
        semantic: semantic[0]?.score ?? null,
        lexical: lexical[0]?.score ?? null,
      },
    };
  }
}
