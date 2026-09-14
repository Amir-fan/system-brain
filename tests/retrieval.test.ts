/**
 * K15 retrieval algorithms: rank fusion, diversity and confidence.
 * These are the deterministic cores the quality numbers depend on, so they are
 * tested with hand-computable expectations rather than assertions about taste.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RRF_K,
  confidenceOf,
  diversify,
  reciprocalRankFusion,
  tokenOverlap,
} from '../src/core/retrieval/retrieval.ts';
import type { CandidateChunk, RetrievalResult } from '../src/core/retrieval/retrieval.ts';

const chunk = (id: string, over: Partial<CandidateChunk> = {}): CandidateChunk => ({
  chunkId: id,
  documentId: over.documentId ?? 'doc-1',
  sourceId: over.sourceId ?? 'src-1',
  logicalPath: over.logicalPath ?? 'docs/a.md',
  text: over.text ?? `body of ${id}`,
  contentSha256: over.contentSha256 ?? `hash-${id}`,
  score: over.score ?? 0.5,
});

describe('reciprocalRankFusion', () => {
  it('uses 1/(k+rank) per ranking', () => {
    const fused = reciprocalRankFusion([
      { name: 'semantic', items: [chunk('a'), chunk('b')] },
      { name: 'lexical', items: [chunk('b')] },
    ]);
    const a = fused.find((f) => f.chunk.chunkId === 'a');
    const b = fused.find((f) => f.chunk.chunkId === 'b');
    assert.equal(a?.fusedScore, 1 / (RRF_K + 1));
    // b is rank 2 semantically and rank 1 lexically: both contributions count.
    assert.equal(b?.fusedScore, 1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    // Agreement wins: b outranks a despite a's better single rank.
    assert.equal(fused[0].chunk.chunkId, 'b');
  });

  it('records the individual ranks and scores as signals', () => {
    const fused = reciprocalRankFusion([
      { name: 'semantic', items: [chunk('a', { score: 0.9 })] },
      { name: 'lexical', items: [chunk('a', { score: 0.3 })] },
    ]);
    assert.equal(fused[0].semanticRank, 1);
    assert.equal(fused[0].semanticScore, 0.9);
    assert.equal(fused[0].lexicalRank, 1);
    assert.equal(fused[0].lexicalScore, 0.3);
  });

  it('never mixes incomparable scales: only ranks matter', () => {
    const high = reciprocalRankFusion([{ name: 'semantic', items: [chunk('a', { score: 0.99 })] }]);
    const low = reciprocalRankFusion([{ name: 'semantic', items: [chunk('a', { score: 0.01 })] }]);
    assert.equal(high[0].fusedScore, low[0].fusedScore);
  });

  it('is deterministic and breaks ties by chunk id', () => {
    const run = () =>
      reciprocalRankFusion([
        { name: 'semantic', items: [chunk('zzz'), chunk('aaa')] },
        { name: 'lexical', items: [chunk('aaa'), chunk('zzz')] },
      ]).map((f) => f.chunk.chunkId);
    assert.deepEqual(run(), run());
    assert.deepEqual(run(), ['aaa', 'zzz']);
  });

  it('applies a retriever weight only when a caller supplies one', () => {
    const unweighted = reciprocalRankFusion([
      { name: 'semantic', items: [chunk('a')] },
      { name: 'lexical', items: [chunk('b')] },
    ]);
    assert.equal(unweighted[0].fusedScore, unweighted[1].fusedScore);
    const weighted = reciprocalRankFusion([
      { name: 'semantic', items: [chunk('a')], weight: 1 },
      { name: 'lexical', items: [chunk('b')], weight: 0.5 },
    ]);
    assert.ok((weighted.find((f) => f.chunk.chunkId === 'a')?.fusedScore ?? 0) >
      (weighted.find((f) => f.chunk.chunkId === 'b')?.fusedScore ?? 0));
  });
});

describe('diversify', () => {
  it('suppresses exact duplicate content', () => {
    const fused = reciprocalRankFusion([
      { name: 'semantic', items: [chunk('a', { contentSha256: 'same' }), chunk('b', { contentSha256: 'same' })] },
    ]);
    const kept = diversify(fused, 8);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].candidate.chunk.chunkId, 'a');
  });

  it('caps how much one document may contribute', () => {
    // Chunk-sized, genuinely distinct text: the cap must be what limits the result.
    const items = Array.from({ length: 8 }, (_, i) =>
      chunk(`c${i}`, {
        documentId: 'doc-1',
        contentSha256: `h${i}`,
        text: Array.from({ length: 30 }, (_, k) => `${i}x${k}`).join(' '),
      }));
    const kept = diversify(reciprocalRankFusion([{ name: 'semantic', items }]), 8, 4);
    assert.equal(kept.length, 4);
  });

  it('does not treat short distinct evidence as a near-duplicate', () => {
    const items = [
      chunk('a', { documentId: 'd1', contentSha256: 'h1', text: 'alpha' }),
      chunk('b', { documentId: 'd1', contentSha256: 'h2', text: 'beta' }),
      chunk('c', { documentId: 'd1', contentSha256: 'h3', text: 'gamma' }),
    ];
    assert.equal(diversify(reciprocalRankFusion([{ name: 'semantic', items }]), 8).length, 3);
  });

  it('keeps breadth across documents and sources', () => {
    const items = [
      chunk('a', { documentId: 'd1', sourceId: 's1', contentSha256: 'h1', text: 'alpha content one' }),
      chunk('b', { documentId: 'd2', sourceId: 's2', contentSha256: 'h2', text: 'beta content two' }),
      chunk('c', { documentId: 'd3', sourceId: 's3', contentSha256: 'h3', text: 'gamma content three' }),
    ];
    const kept = diversify(reciprocalRankFusion([{ name: 'semantic', items }]), 8);
    assert.equal(kept.length, 3);
    assert.equal(new Set(kept.map((k) => k.candidate.chunk.sourceId)).size, 3);
  });

  it('suppresses near-duplicate overlapping regions of the same document', () => {
    const text = Array.from({ length: 30 }, (_, k) => `segment${k}`).join(' ');
    const items = [
      chunk('a', { documentId: 'd1', contentSha256: 'h1', text }),
      chunk('b', { documentId: 'd1', contentSha256: 'h2', text: text + ' additional' }),
      chunk('c', {
        documentId: 'd1',
        contentSha256: 'h3',
        text: Array.from({ length: 30 }, (_, k) => `other${k}`).join(' '),
      }),
    ];
    const kept = diversify(reciprocalRankFusion([{ name: 'semantic', items }]), 8);
    const ids = kept.map((k) => k.candidate.chunk.chunkId);
    assert.deepEqual(ids, ['a', 'c']);
  });

  it('stops at the requested limit', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      chunk(`c${i}`, { documentId: `d${i}`, contentSha256: `h${i}`, text: `distinct body ${i}` }));
    assert.equal(diversify(reciprocalRankFusion([{ name: 'semantic', items }]), 8).length, 8);
  });
});

describe('tokenOverlap', () => {
  it('is 0 for disjoint text and 1 for identical text', () => {
    assert.equal(tokenOverlap('alpha beta', 'gamma delta'), 0);
    assert.equal(tokenOverlap('alpha beta', 'alpha beta'), 1);
  });
});

describe('confidenceOf', () => {
  const result = (foundBy: string[], semanticScore?: number): RetrievalResult => ({
    chunkId: 'c',
    documentId: 'd',
    sourceId: 's',
    text: 'body',
    score: 0.03,
    retrievalSignals: {
      fusedScore: 0.03,
      foundBy,
      diverse: true,
      ...(semanticScore !== undefined ? { semanticScore } : {}),
    },
  });

  it('reports measured values, not a verdict', () => {
    const conf = confidenceOf([result(['semantic', 'lexical'], 0.72), result(['semantic'], 0.65)]);
    assert.equal(conf.resultCount, 2);
    assert.equal(conf.agreement, 0.5);
    assert.equal(conf.topSemanticScore, 0.72);
    assert.equal(conf.singleRetrieverEvidence, false);
  });

  it('flags single-retriever evidence', () => {
    assert.equal(confidenceOf([result(['semantic'])]).singleRetrieverEvidence, true);
  });

  it('is empty-safe', () => {
    const conf = confidenceOf([]);
    assert.equal(conf.resultCount, 0);
    assert.equal(conf.topSemanticScore, null);
    assert.equal(conf.agreement, 0);
  });
});
