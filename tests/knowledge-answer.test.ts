/**
 * K16 safety core: the sufficiency gate and the citation-integrity layer.
 * These are the tests that keep KIP from answering with no evidence or with a
 * fabricated citation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessSufficiency,
  inferLanguage,
  parseModelAnswer,
  verifyGroundedShape,
} from '../src/core/knowledge/knowledge-answer.ts';
import type { RetrievalSummary } from '../src/core/knowledge/knowledge-answer.ts';

const summary = (over: Partial<RetrievalSummary> = {}): RetrievalSummary => ({
  resultCount: 8,
  semanticCandidates: 30,
  lexicalCandidates: 30,
  topSemanticScore: 0.72,
  topLexicalScore: 0.5,
  agreement: 0.5,
  modelId: 'google/gemini-embedding-001',
  ...over,
});

const evidence = (n: number, docs = 4) =>
  Array.from({ length: n }, (_, i) => ({
    documentId: `doc-${i % Math.max(docs, 1)}`,
    sourceId: `src-${i % 2}`,
    excerpt: `excerpt ${i} with enough words to count`,
  }));

describe('assessSufficiency', () => {
  it('refuses when nothing meaningful was retrieved', () => {
    const g = assessSufficiency(summary({ resultCount: 0, topSemanticScore: 0.4 }), [], 'سؤال؟');
    assert.equal(g.decision, 'insufficient');
    assert.equal(g.confidence, 'low');
  });

  it('refuses below the measured answerable cosine floor', () => {
    // K15 measured floor: answerable min 0.6218, not-present 0.4607.
    const g = assessSufficiency(summary({ topSemanticScore: 0.5 }), evidence(3), 'ما هو؟');
    assert.equal(g.decision, 'insufficient');
  });

  it('proceeds above the floor', () => {
    const g = assessSufficiency(summary({ topSemanticScore: 0.72 }), evidence(4), 'ما هو التعلم العميق؟');
    assert.equal(g.decision, 'proceed');
    assert.equal(g.confidence, 'high'); // strong score + agreement + ≥2 documents
  });

  it('is medium confidence for a single strong document without agreement', () => {
    const g = assessSufficiency(summary({ topSemanticScore: 0.65, agreement: 0 }), evidence(2, 1), 'كيف يعمل؟');
    assert.equal(g.decision, 'proceed');
    assert.equal(g.confidence, 'medium');
  });

  it('asks for clarification on a bare question spanning many documents', () => {
    const g = assessSufficiency(summary({ topSemanticScore: 0.7 }), evidence(8, 5), 'الإصدار');
    assert.equal(g.decision, 'clarify');
  });

  it('records the gate inputs as observable signals, never hidden reasoning', () => {
    // multi-token question so the ambiguity rule does not fire; we are testing the signals.
    const g = assessSufficiency(summary({ topSemanticScore: 0.66, agreement: 0.25 }), evidence(3), 'كيف تتم معالجة البيانات؟');
    assert.equal(g.signals.semanticFloor, 0.62);
    assert.equal(g.signals.distinctDocuments, 3);
    assert.equal(g.signals.gate, 'proceeded');
    assert.ok(g.signals.evidenceChars > 0);
  });
});

describe('parseModelAnswer — citation integrity', () => {
  const labels = ['E1', 'E2', 'E3', 'E4'];

  it('accepts a valid structured answer with real citations', () => {
    const r = parseModelAnswer(JSON.stringify({ status: 'answered', answer: 'جواب مدعوم.', confidence: 'high', citations: ['E1', 'E3'] }), labels);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.citations.length, 2);
      assert.equal(r.value.rejectedCitations.length, 0);
    }
  });

  it('REJECTS a fabricated citation id like [E99]', () => {
    const r = parseModelAnswer(JSON.stringify({ status: 'answered', answer: 'جواب.', citations: ['E1', 'E99'] }), labels);
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.value.citations, ['E1']);
      assert.deepEqual(r.value.rejectedCitations, ['E99']);
    }
  });

  it('refuses an "answered" output that has no citations at all', () => {
    const r = parseModelAnswer(JSON.stringify({ status: 'answered', answer: 'ادعاء بلا دليل.' }), labels);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, 'no_valid_citations');
  });

  it('refuses an "answered" output with an empty answer', () => {
    const r = parseModelAnswer(JSON.stringify({ status: 'answered', answer: '   ', citations: ['E1'] }), labels);
    assert.ok(!r.ok);
  });

  it('tolerates JSON wrapped in fenced prose', () => {
    const raw = 'Sure!\n```json\n{"status":"answered","answer":"ok","citations":["E2"]}\n```';
    const r = parseModelAnswer(raw, labels);
    assert.ok(r.ok);
  });

  it('rejects an unknown status', () => {
    assert.ok(!parseModelAnswer(JSON.stringify({ status: 'guessed', answer: 'x', citations: ['E1'] }), labels).ok);
  });

  it('requires a clarification question for needs_clarification', () => {
    assert.ok(!parseModelAnswer(JSON.stringify({ status: 'needs_clarification', clarification: null }), labels).ok);
    const ok = parseModelAnswer(JSON.stringify({ status: 'needs_clarification', clarification: 'أي إصدار تقصد؟', choices: ['v1', 'v2'] }), labels);
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.value.clarification?.choices?.length, 2);
  });

  it('accepts conflicting_evidence without fabricating a resolution', () => {
    const r = parseModelAnswer(JSON.stringify({ status: 'conflicting_evidence', message: '30 versus 90 days.' }), labels);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.status, 'conflicting_evidence');
  });
});

describe('verifyGroundedShape', () => {
  it('rejects an answered result without citations', () => {
    assert.equal(verifyGroundedShape({ status: 'answered', answer: 'x', citations: [] }).ok, false);
  });
  it('rejects an insufficient result that cites evidence', () => {
    assert.equal(verifyGroundedShape({ status: 'insufficient_evidence', citations: ['E1'] }).ok, false);
  });
  it('accepts a well-shaped answered result', () => {
    assert.equal(verifyGroundedShape({ status: 'answered', answer: 'x', citations: ['E1'] }).ok, true);
  });
});

describe('inferLanguage', () => {
  it('respects an explicit language request', () => {
    assert.equal(inferLanguage('hello', 'ar'), 'ar');
  });
  it('infers Arabic from Arabic script and English from Latin', () => {
    assert.equal(inferLanguage('ما هو مستقبل الذكاء الاصطناعي'), 'ar');
    assert.equal(inferLanguage('what is the future of ai'), 'en');
  });
});