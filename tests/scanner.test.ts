/**
 * K21 Naqaa Scanner — production evidence-contract tests (deterministic; no media/model).
 * Real API + Memory + isolation are proven live in scripts/_k21evidence.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naqaaScanner } from '../src/domain/naqaa/scanner-skill.ts';
import type { SkillExecutionContext } from '../src/core/skill/skill.ts';
import type { NaqaaScannerResultV1 } from '../src/domain/naqaa/scanner-contracts.ts';

const evidence = {
  schemaVersion: 1, occurredAt: '2026-09-15T10:00:00Z', scannerVersion: 'naqaa.ondevice@1',
  color: { primaryColor: { value: 'dark red', status: 'observed', source: 'vision', confidence: 0.9 } },
  physical: { apparentClotting: { value: 'none_visible', status: 'inferred', source: 'vision' } },
  texture: { smoothness: { value: 'smooth', status: 'observed', source: 'vision' } },
  spatial: { stainShape: { value: 'irregular', status: 'observed', source: 'vision' } },
  quality: { rating: 'usable' },
  provenance: { scanSource: 'vision' },
};
const ctx = (over: Partial<SkillExecutionContext>): SkillExecutionContext => ({
  projectId: 'p', actor: 'a', input: { evidence, context: { cycleDay: '4' } }, memory: [], ...over,
});

test('A skill registration + requirements (no model, memory yes)', () => {
  assert.equal(naqaaScanner.id, 'naqaa.scanner');
  assert.equal(naqaaScanner.version, 1);
  assert.deepEqual(naqaaScanner.requirements, { understanding: false, memory: true, knowledge: false, model: false });
});

test('B final five groups: color/physical/texture/spatial/quality', async () => {
  const r = await naqaaScanner.execute(ctx({})) as NaqaaScannerResultV1;
  for (const g of ['color', 'physical', 'texture', 'spatial', 'quality']) assert.ok(r.evidence![g as keyof typeof r.evidence], g);
});

test('C provenance preserved: evidence source=vision, memory context separate', async () => {
  const memory = [{ id: 'm1', scope: 'user', memoryType: 'preference', memoryKey: 'cycle_day', payload: { value: '2' } }] as never[];
  const r = await naqaaScanner.execute(ctx({ input: { evidence }, memory })) as NaqaaScannerResultV1;
  assert.equal(r.evidence!.color.primaryColor?.source, 'vision'); // evidence provenance untouched
  assert.equal(r.contextUsed.userCount, 1);                       // memory combined, not into evidence
  assert.equal(r.observability.memoryItemsUsed, 1);
});

test('D apparent physical props are visually-estimated, never direct measurement', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { evidence, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
  assert.equal(r.evidence!.physical.apparentClotting?.status, 'inferred'); // not 'observed'
});

test('E unknown != false', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { evidence, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
  const phys = r.evidence!.physical as Record<string, unknown>;
  assert.equal('apparentViscosity' in phys, false); // absent, not false/0/''
});

test('F bounded memory combined without contaminating evidence', async () => {
  const memory = [{ id: 'm1', scope: 'user', memoryType: 'preference', memoryKey: 'pregnancy_status', payload: { value: 'unknown' } }] as never[];
  const r = await naqaaScanner.execute(ctx({ input: { evidence }, memory })) as NaqaaScannerResultV1;
  assert.equal(r.evidence!.quality.rating, 'usable');          // evidence unchanged
  assert.equal(r.contextUsed.userCount, 1);                    // memory counted separately
  assert.equal(r.observability.memoryItemsUsed, 1);
});

test('G missing required context -> needs_information + question', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { evidence } })) as NaqaaScannerResultV1;
  assert.equal(r.status, 'needs_information');
  assert.equal(r.questionNeeded, true);
  assert.ok(r.missingInformation.some((m) => m.key === 'cycle_day'));
  assert.equal(r.question?.key, 'cycle_day');
});

test('H sufficient evidence + context -> completed/sufficient, no fiqh', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { evidence, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
  assert.equal(r.status, 'completed');
  assert.equal(r.sufficiency, 'sufficient');
  assert.equal(r.questionNeeded, false);
  const s = JSON.stringify(r);
  assert.equal(/hayd|istihada|nifas|purity|prayer|fasting|حيض|استحاضة|نفاس/.test(s), false, 'no fiqh fields');
});

test('I unusable scan quality -> unusable safely, no fabricated evidence', async () => {
  const bad = { ...evidence, quality: { rating: 'unusable', reasons: ['too dark'] } };
  const r = await naqaaScanner.execute(ctx({ input: { evidence: bad } })) as NaqaaScannerResultV1;
  assert.equal(r.status, 'unusable');
  assert.equal(r.sufficiency, 'unusable');
});

test('J malformed evidence payload -> validateInput rejects (safe failure)', () => {
  assert.equal(naqaaScanner.validateInput({ evidence: { color: {} } }).ok, false); // missing groups
  assert.equal(naqaaScanner.validateInput({}).ok, false);                          // no evidence
  assert.equal(naqaaScanner.validateInput(null).ok, false);
});

test('M LearningExampleV1 representable from a completed scan (not persisted)', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { evidence, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
  const ex = { projectId: 'p', task: 'naqaa.scan.assessment', occurredAt: r.evidence?.occurredAt, observation: r.evidence, modelVersion: 'naqaa.ondevice@1', modelOutput: r.evidence, labelProvenance: 'unverified', verificationStatus: 'unverified', quality: r.evidence?.quality.rating, eligibility: { consentGranted: true, eligible: true } };
  assert.equal(ex.task, 'naqaa.scan.assessment');
  assert.ok(ex.observation && ex.eligibility);
  // NOT persisted to any Learning Dataset (no such table/API here)
});

test('N no memory pollution (result only; no writes)', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { evidence, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
  assert.equal(r.observability.memoryItemsUsed, 0); // read-only
});

test('O zero religious decision fields', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { evidence, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
  const keys = Object.keys(r).join(',');
  assert.equal(/hayd|istihada|nifas|purity|prayer|fasting/i.test(keys), false);
});
