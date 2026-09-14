/**
 * @kip
 * @module provider
 * @layer platform
 * @owner platform-infra
 * @feature K1-004
 * @purpose Supabase-backed retrieval: the two candidate retrievers + index model read.
 *
 * Both searches call SQL functions that scope by project_id IN THE QUERY, so no
 * other project's rows are ever fetched and filtered in memory. Chunk text is
 * returned for ranking evidence only and is never logged.
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import type {
  CandidateChunk,
  LexicalRetrieverPort,
  RetrievalIndexReader,
  VectorRetrieverPort,
} from '../../core/retrieval/retrieval.ts';

const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;

const mapRow = (r: Record<string, unknown>): CandidateChunk => ({
  chunkId: r.chunk_id as string,
  documentId: r.document_id as string,
  sourceId: r.source_id as string,
  logicalPath: (r.logical_path as string) ?? undefined,
  headingContext: (r.heading_context as string) ?? undefined,
  text: (r.text_content as string) ?? '',
  contentSha256: (r.content_sha256 as string) ?? '',
  score: Number(r.score ?? 0),
});

export interface RetrievalStorage extends VectorRetrieverPort, LexicalRetrieverPort, RetrievalIndexReader {}

export function createRetrievalStorage(db: SupabaseDatabase): RetrievalStorage {
  return {
    async vectorSearch({ projectId, modelId, queryVector, limit, filters }) {
      const { data, error } = (await db.rpc('kip_retrieve_vector', {
        p_project_id: projectId,
        p_model_id: modelId,
        p_query: toVectorLiteral(queryVector),
        p_limit: limit,
        p_source_ids: filters.sourceIds ?? null,
        p_document_ids: filters.documentIds ?? null,
      })) as unknown as { data: Array<Record<string, unknown>> | null; error: unknown };
      if (error) throw new Error('vector search failed');
      return (data ?? []).map(mapRow);
    },

    async lexicalSearch({ projectId, query, limit, filters }) {
      const { data, error } = (await db.rpc('kip_retrieve_lexical', {
        p_project_id: projectId,
        p_query: query,
        p_limit: limit,
        p_source_ids: filters.sourceIds ?? null,
        p_document_ids: filters.documentIds ?? null,
      })) as unknown as { data: Array<Record<string, unknown>> | null; error: unknown };
      if (error) throw new Error('lexical search failed');
      return (data ?? []).map(mapRow);
    },

    async indexedModelId(projectId) {
      const { data } = await db
        .from('chunk_embeddings')
        .select('model_id')
        .eq('project_id', projectId)
        .limit(1);
      const row = (data ?? [])[0];
      return row ? (row as Record<string, unknown>).model_id as string : null;
    },
  };
}
