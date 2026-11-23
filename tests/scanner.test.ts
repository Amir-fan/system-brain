/**
 * K21 Naqaa Scanner — production evidence-contract tests (deterministic; no media/model).
 * Real API + Memory + isolation are proven live in scripts/_k21evidence.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naqaaScanner } from '../src/domain/naqaa/scanner-skill.ts';
import type { SkillExecutionContext } from '../src/core/skill/skill.ts';
import type { NaqaaScannerResultV1 } from '../src/domain/naqaa/scanner-contracts.ts';
import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import { handleSkillExecute } from '../src/platform/api/skill-handler.ts';
import type { RunRecord } from '../src/core/runtime/runtime.ports.ts';

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

test('Task 6: occurredAt accepts and preserves an explicit RFC 3339 offset', async () => {
  const occurredAt = '2026-11-19T21:15:00+03:00';
  const withOffset = { ...evidence, occurredAt };

  assert.deepEqual(naqaaScanner.validateInput({ evidence: withOffset }), { ok: true });
  const result = await naqaaScanner.execute(ctx({ input: { evidence: withOffset, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
  assert.equal(result.evidence?.occurredAt, occurredAt);
});

test('Task 6: occurredAt rejects missing zones, impossible dates, and non-strings', () => {
  for (const occurredAt of [
    '2026-11-19T21:15:00',
    '2026-02-30T21:15:00+03:00',
    '2026-11-19T25:15:00+03:00',
    1_768_000_000,
  ]) {
    const result = naqaaScanner.validateInput({ evidence: { ...evidence, occurredAt } });
    assert.equal(result.ok, false, String(occurredAt));
  }
});

test('Task 6: raw media fields are excluded from scanner output', async () => {
  const untrustedEvidence = {
    ...evidence,
    rawMedia: 'secret-image-bytes',
    image: 'data:image/png;base64,secret-image-bytes',
  };
  const result = await naqaaScanner.execute(ctx({
    input: { evidence: untrustedEvidence, context: { cycleDay: '4' } },
  })) as NaqaaScannerResultV1;

  const output = JSON.stringify(result);
  assert.equal(output.includes('rawMedia'), false);
  assert.equal(output.includes('secret-image-bytes'), false);
});

test('Task 6 fix round 1: nested media and debug containers cannot cross the runtime boundary', async () => {
  const secret = 'secret-base64-image-payload';
  const untrustedEvidence = {
    ...evidence,
    color: {
      ...evidence.color,
      primaryColor: {
        value: { base64: secret },
        status: 'observed',
        source: 'vision',
        clientDebug: { rawImage: secret },
      },
      clientDebug: { value: secret, status: 'observed', source: 'vision' },
    },
    provenance: {
      scanSource: 'vision',
      note: 'on-device inference',
      rawImage: secret,
      clientDebug: { blob: secret },
    },
  };
  const registry = new MapSkillRegistry();
  registry.register(naqaaScanner);
  const runtime = new SkillsRuntime({
    registry,
    persistence: {
      getProject: async () => ({ id: 'p', name: 'p', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }),
      getMembership: async () => ({ projectId: 'p', actor: 'a', role: 'member', createdAt: '2026-01-01T00:00:00Z' }),
      createRun: async () => undefined,
      updateRun: async () => undefined,
    },
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
  });

  const result = await runtime.execute({
    projectId: 'p', actor: 'a', skillId: 'naqaa.scanner',
    payload: { evidence: untrustedEvidence, context: { cycleDay: '4' } },
  });
  const runtimeOutput = result.output as NaqaaScannerResultV1;
  const serialized = JSON.stringify(runtimeOutput);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('clientDebug'), false);
  assert.deepEqual(runtimeOutput.evidence?.provenance, { scanSource: 'vision', note: 'on-device inference' });
  assert.equal(runtimeOutput.evidence?.color.primaryColor, undefined, 'a non-scalar feature value is dropped');
  assert.equal(Object.hasOwn(runtimeOutput.evidence?.color ?? {}, 'clientDebug'), false);
});

test('Task 6 fix round 2: recognizable media text cannot cross the API, runtime, or run boundary', async () => {
  const secrets = [
    'attachment: data:image/png;base64,abc123',
    'preview = data:audio/wav;base64,abc123',
    'clip data:video/mp4;base64,abc123',
    'attachment: data:application/octet-stream;base64,abc123',
    'debug blob:raw-camera-frame',
    'payload base64:YWJjMTIz',
    'capture media://device-capture',
    'binary\u0000payload',
  ];
  const untrustedEvidence = {
    ...evidence,
    evidenceId: secrets[4],
    scannerVersion: secrets[5],
    color: {
      primaryColor: { value: secrets[0], status: 'observed', source: 'vision', method: secrets[1], unit: secrets[2] },
      brightness: { value: 'ordinary brightness', status: 'observed', source: 'vision' },
    },
    quality: {
      rating: 'usable',
      lightingQuality: secrets[6],
      focusClarity: 'clear',
      reasons: [secrets[3], secrets[5], 'ordinary media review note', secrets[7]],
    },
    provenance: { scanSource: 'vision', note: 'image quality reviewed by media team' },
  };
  const runs: RunRecord[] = [];
  const persistence = {
    getProject: async () => ({ id: 'p', name: 'p', status: 'active' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }),
    getMembership: async () => ({ projectId: 'p', actor: 'a', role: 'member' as const, createdAt: '2026-01-01T00:00:00Z' }),
    createRun: async (run: RunRecord) => { runs.push({ ...run }); },
    updateRun: async (id: string, patch: Partial<RunRecord>) => { Object.assign(runs.find((run) => run.id === id)!, patch); },
  };
  const registry = new MapSkillRegistry();
  registry.register(naqaaScanner);
  const runtime = new SkillsRuntime({
    registry, persistence,
    memory: { fetchBounded: async () => ({ user: [], conversation: [], case: [] }) },
  });

  const response = await handleSkillExecute(
    { runtime, registry, boundary: persistence },
    'p', 'a', 'naqaa.scanner',
    { payload: { evidence: untrustedEvidence, context: { cycleDay: '4' } } },
  );
  const serializedResponse = JSON.stringify(response);
  const serializedRuns = JSON.stringify(runs);

  for (const secret of secrets) {
    assert.equal(serializedResponse.includes(secret), false, secret);
    assert.equal(serializedRuns.includes(secret), false, `run: ${secret}`);
  }
  assert.equal(response.ok, true);
  const output = (response as { data: { output: NaqaaScannerResultV1 } }).data.output.evidence!;
  assert.equal(output.color.primaryColor, undefined);
  assert.equal(output.color.brightness?.value, 'ordinary brightness');
  assert.equal(output.quality.focusClarity, 'clear');
  assert.deepEqual(output.quality.reasons, ['ordinary media review note']);
  assert.deepEqual(output.provenance, { scanSource: 'vision', note: 'image quality reviewed by media team' });
});

test('Task 6 fix round 1: RFC 3339 lowercase UTC and real leap seconds are accepted verbatim', async () => {
  for (const occurredAt of [
    '2026-11-19t21:15:00z',
    '2016-12-31T23:59:60Z',
    '2017-01-01T00:59:60+01:00',
  ]) {
    const candidate = { ...evidence, occurredAt };
    assert.deepEqual(naqaaScanner.validateInput({ evidence: candidate }), { ok: true }, occurredAt);
    const result = await naqaaScanner.execute(ctx({ input: { evidence: candidate, context: { cycleDay: '4' } } })) as NaqaaScannerResultV1;
    assert.equal(result.evidence?.occurredAt, occurredAt);
  }
});

test('Task 6 fix round 1: arbitrary second 60 values fail closed', () => {
  for (const occurredAt of [
    '2026-11-19T21:15:60Z',
    '2016-12-31T23:58:60Z',
    '2016-12-30T23:59:60Z',
    '2017-01-01T00:59:60+02:00',
  ]) {
    assert.equal(naqaaScanner.validateInput({ evidence: { ...evidence, occurredAt } }).ok, false, occurredAt);
  }
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
