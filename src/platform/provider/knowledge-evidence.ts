/**
 * @kip
 * @module provider
 * @layer platform
 * @owner platform-infra
 * @feature K25
 * @purpose Platform adapter for the generic Skill Knowledge capability.
 *
 * Reuses the EXISTING retriever (K15) and the EXISTING ingestion persistence for
 * chunk adjacency — no second retrieval engine, no new table, no new index. The
 * project id is bound by the caller (the Skills Runtime), so a skill can only ever
 * search its own project's knowledge.
 */

import type { RetrievalService } from '../../core/retrieval/retrieval.service.ts';
import type { SkillKnowledgeCapability, SkillKnowledgePassage } from '../../core/skill/skill.ts';
import type { ChunkRecord, ChunkSummary } from '../../core/ingestion/chunk.ts';

/** Bounded adjacency: at most this many chunks on each side of a passage. */
export const MAX_ADJACENT_WINDOW = 2;

interface SourceTitleReader {
  listByProject(projectId: string, includeArchived?: boolean): Promise<Array<{ id: string; title: string }>>;
}

interface ChunkReader {
  listChunkSummaries(projectId: string, documentId: string): Promise<ChunkSummary[]>;
  getChunk(projectId: string, chunkId: string): Promise<ChunkRecord | null>;
}

export interface KnowledgeEvidenceDeps {
  projectId: string;
  retrieval: Pick<RetrievalService, 'search'>;
  sources: SourceTitleReader;
  chunks: ChunkReader;
}

export function createKnowledgeEvidence(deps: KnowledgeEvidenceDeps): SkillKnowledgeCapability {
  const { projectId } = deps;
  // Titles are resolved once per capability instance (the capability is created per
  // skill execution, so this never goes stale within a turn).
  let titles: Map<string, string> | null = null;
  const titleOf = async (sourceId: string): Promise<string> => {
    if (!titles) {
      const list = await deps.sources.listByProject(projectId).catch(() => []);
      titles = new Map(list.map((s) => [s.id, s.title]));
    }
    return titles.get(sourceId) ?? '';
  };

  const toPassage = async (r: {
    chunkId: string;
    documentId: string;
    sourceId: string;
    text: string;
    logicalPath?: string;
    headingContext?: string;
    score?: number;
  }, chunkIndex: number): Promise<SkillKnowledgePassage> => ({
    chunkId: r.chunkId,
    documentId: r.documentId,
    sourceId: r.sourceId,
    sourceTitle: await titleOf(r.sourceId),
    chunkIndex,
    text: r.text,
    ...(r.logicalPath ? { logicalPath: r.logicalPath } : {}),
    ...(r.headingContext ? { headingContext: r.headingContext } : {}),
    ...(typeof r.score === 'number' ? { score: r.score } : {}),
  });

  return {
    async search(input) {
      const outcome = await deps.retrieval.search({
        projectId,
        query: input.query,
        topK: input.topK ?? 4,
        ...(input.sourceIds && input.sourceIds.length > 0 ? { filters: { sourceIds: input.sourceIds } } : {}),
      });
      const passages: SkillKnowledgePassage[] = [];
      for (const h of outcome.results) {
        // Chunk index is not part of the retrieval hit; read it from the chunk row.
        const row = await deps.chunks.getChunk(projectId, h.chunkId).catch(() => null);
        passages.push(
          await toPassage(
            {
              chunkId: h.chunkId,
              documentId: h.documentId,
              sourceId: h.sourceId,
              text: h.text,
              ...(h.logicalPath ? { logicalPath: h.logicalPath } : {}),
              ...(h.headingContext ? { headingContext: h.headingContext } : {}),
              score: h.score,
            },
            row?.index ?? -1,
          ),
        );
      }
      return passages;
    },

    async resolveSources(sourceTitles) {
      const list = await deps.sources.listByProject(projectId).catch(() => []);
      const wanted = new Set(sourceTitles.map((t) => t.trim()));
      return list.filter((s) => wanted.has((s.title ?? '').trim())).map((s) => ({ id: s.id, title: s.title }));
    },

    async adjacent(chunkId, window = 1) {
      const w = Math.max(0, Math.min(MAX_ADJACENT_WINDOW, Math.trunc(window)));
      if (w === 0) return [];
      const anchor = await deps.chunks.getChunk(projectId, chunkId).catch(() => null);
      if (!anchor) return [];
      const siblings = await deps.chunks.listChunkSummaries(projectId, anchor.documentId).catch(() => []);
      const ids = siblings
        .filter((c) => c.id !== anchor.id && Math.abs(c.chunkIndex - anchor.index) <= w)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const out: SkillKnowledgePassage[] = [];
      for (const s of ids) {
        const row = await deps.chunks.getChunk(projectId, s.id).catch(() => null);
        if (!row) continue;
        out.push(
          await toPassage(
            {
              chunkId: row.id,
              documentId: row.documentId,
              sourceId: row.sourceId,
              text: row.text,
              ...(row.logicalPath ? { logicalPath: row.logicalPath } : {}),
              ...(row.headingContext ? { headingContext: row.headingContext } : {}),
            },
            row.index,
          ),
        );
      }
      return out;
    },
  };
}
