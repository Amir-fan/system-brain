/**
 * K21 Naqaa Scanner — deterministic scanner logic tests (mocked model capability).
 * The REAL vision path (media -> gateway -> vision_scan -> model) is proven live in
 * scripts/_k21scanner.mjs and the vision feasibility gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naqaaScanner } from '../src/domain/naqaa/scanner-skill.ts';
import { SkillFailure } from '../src/core/skill/skill.ts';
import type { SkillExecutionContext, SkillModelCapability } from '../src/core/skill/skill.ts';
import type { NaqaaScannerResultV1 } from '../src/domain/naqaa/scanner-contracts.ts';

const img = 'data:image/png;base64,AAA=';
const model = (text: string): SkillModelCapability => ({
  async generateText() { return { text, provider: 'openrouter', model: 'gemini-3.5-flash' }; },
});
const visionJson = {
  quality: { rating: 'usable', reasons: [] },
  color: { dominantColor: 'red', saturation: 'high', brightness: 'medium', colorUniformity: 'uniform' },
  physical: { clotting: 'none_visible' },
  texture: { smoothness: 'smooth', granularity: 'fine' },
  spatial: { stainArea: 'medium', stainShape: 'irregular', spreadRatio: 'low' },
};
const ctx = (over: Partial<SkillExecutionContext>): SkillExecutionContext => ({
  projectId: 'p', actor: 'a', input: { media: { dataUrl: img } }, memory: [], model: model(JSON.stringify(visionJson)), ...over,
});

test('A skill registration/resolution', () => {
  assert.equal(naqaaScanner.id, 'naqaa.scanner');
  assert.equal(naqaaScanner.version, 1);
  assert.deepEqual(naqaaScanner.requirements, { understanding: false, memory: true, knowledge: false, model: true });
});

test('B complete structured observation: five groups present', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { media: { dataUrl: img }, context: { cycleDay: '3' } } })) as NaqaaScannerResultV1;
  assert.equal(r.status, 'completed');
  const o = r.observation!;
  for (const g of ['color', 'physical', 'texture', 'spatial', 'contextual']) assert.ok(o[g as keyof typeof o], g);
});

test('C provenance: vision vs memory vs user distinguishable', async () => {
  const memory = [
    { id: 'm1', scope: 'user', memoryType: 'preference', memoryKey: 'pregnancy_status', payload: { value: 'unknown' } },
  ] as never[];
  const r = await naqaaScanner.execute(ctx({
    input: { media: { dataUrl: img }, context: { cycleDay: '5' } },
    memory,
  })) as NaqaaScannerResultV1;
  const o = r.observation!;
  assert.equal(o.color.dominantColor?.source, 'vision');
  assert.equal(o.contextual.cycleDay?.source, 'user');
  assert.equal(o.contextual.pregnancyStatus?.source, 'memory');
});

test('D unavailable image-only physical property is null, never observed', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { media: { dataUrl: img }, context: { cycleDay: '3' } } })) as NaqaaScannerResultV1;
  const v = r.observation!.physical.viscosity;
  assert.equal(v?.status, 'unavailable');
  assert.equal(v?.value, null);
});

test('E UNKNOWN != FALSE: pregnancy status unavailable is null not false', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { media: { dataUrl: img }, context: { cycleDay: '3' } } })) as NaqaaScannerResultV1;
  const c = r.observation!.contextual;
  assert.equal(c.pregnancyStatus ?? undefined, undefined); // absent, not false
  assert.equal(JSON.stringify(c).includes('"false"'), false);
});

test('G missing required information -> needs_information + question', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { media: { dataUrl: img } } })) as NaqaaScannerResultV1;
  assert.equal(r.status, 'needs_information');
  assert.equal(r.questionNeeded, true);
  assert.ok(r.missingInformation.some((m) => m.key === 'cycle_day'));
  assert.equal(r.question?.key, 'cycle_day');
});

test('H sufficient scanner input with cycleDay -> completed, no question, NO fiqh', async () => {
  const r = await naqaaScanner.execute(ctx({ input: { media: { dataUrl: img }, context: { cycleDay: '3' } } })) as NaqaaScannerResultV1;
  assert.equal(r.status, 'completed');
  assert.equal(r.sufficiency, 'sufficient');
  assert.equal(r.questionNeeded, false);
  const s = JSON.stringify(r);
  assert.equal(/hayd|istihada|nifas|purity|prayer|fasting|حيض|استحاضة|نفاس/.test(s), false, 'no fiqh fields');
});

test('I unusable media -> unusable, no fabricated features', async () => {
  const bad = { quality: { rating: 'unusable', reasons: ['too dark'] }, color: {} };
  const r = await naqaaScanner.execute(ctx({ model: model(JSON.stringify(bad)) })) as NaqaaScannerResultV1;
  assert.equal(r.status, 'unusable');
  assert.equal(r.sufficiency, 'unusable');
  assert.equal(r.observation, undefined);
});

test('J malformed vision output -> safe failure (throws)', async () => {
  await assert.rejects(naqaaScanner.execute(ctx({ model: model('here is some prose, not json') })), (e: unknown) => (e as Error) instanceof SkillFailure);
});

test('N no memory pollution (result only; no memory writes) + bounded memory used', async () => {
  const memory = [{ id: 'm1', scope: 'user', memoryType: 'preference', memoryKey: 'cycle_day', payload: { value: '2' } }] as never[];
  const r = await naqaaScanner.execute(ctx({ input: { media: { dataUrl: img } }, memory })) as NaqaaScannerResultV1;
  assert.equal(r.observability.memoryItemsUsed, 1);
  assert.equal(r.observation!.contextual.cycleDay?.source, 'memory');
});
