import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, sha256Hex } from '../src/core/ingestion/normalize.ts';
import { IngestionFailure } from '../src/core/ingestion/ingestion.types.ts';
import { ActiveIngestionJobExistsError } from '../src/core/ingestion/ingestion.ports.ts';
import { SourceAcquisitionRouter } from '../src/core/ingestion/acquisition-router.ts';
import { IngestionService } from '../src/core/ingestion/ingestion.service.ts';
import { createTextAcquisitionAdapter } from '../src/platform/ingestion/text-acquisition.ts';
import { createFileAcquisitionAdapter } from '../src/platform/ingestion/file-acquisition.ts';

test('normalize: line endings, BOM, blank runs, outer trim', () => {
  const raw = '\uFEFF  a\r\n\r\n\r\n\r\nb\r\nc  \n\n\n';
  const n = normalizeText(raw);
  assert.equal(n.text, 'a\n\nb\nc');
  assert.equal(n.charCount, 6);
  assert.equal(n.sha256, sha256Hex('a\n\nb\nc'));
});

test('normalize: preserves wording and inner single blank lines', () => {
  const raw = 'السطر الأول\n\nالسطر الثاني';
  assert.equal(normalizeText(raw).text, raw);
});

test('normalize: deterministic and code-point counted', () => {
  const a = normalizeText('x\u{1F600}y');
  assert.equal(a.charCount, 3, 'emoji counts as one code point');
  assert.deepEqual(normalizeText('same text'), normalizeText('same text'));
  assert.notEqual(sha256Hex('a'), sha256Hex('b'));
  assert.match(normalizeText('abc').sha256, /^[0-9a-f]{64}$/);
});

test('normalize: empty-ish input yields empty text with a valid hash', () => {
  const n = normalizeText('   \n\n  ');
  assert.equal(n.text, '');
  assert.equal(n.charCount, 0);
  assert.match(n.sha256, /^[0-9a-f]{64}$/);
});

interface FakeJob {
  id: string;
  projectId: string;
  sourceId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attemptNumber: number;
  triggerType: 'manual' | 'retry';
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdBySubject: string;
  createdAt: string;
  updatedAt: string;
}

function fakePersistence(seed?: { activeJob?: FakeJob | null }) {
  const jobs: FakeJob[] = [];
  const outputs: Array<Record<string, unknown>> = [];
  const state = { activeJob: seed?.activeJob ?? null };
  let counter = 0;

  return {
    jobs,
    outputs,
    state,
    persistence: {
      findActiveJob: async () => state.activeJob,
      getJob: async (_p: string, id: string) => jobs.find((j) => j.id === id) ?? null,
      latestJob: async () => jobs[jobs.length - 1] ?? null,
      listJobs: async () => jobs,
      listLatestJobsByProject: async () => jobs,
      nextAttemptNumber: async () => jobs.length + 1,
      createJob: async (input: { projectId: string; sourceId: string; attemptNumber: number; triggerType: 'manual' | 'retry'; createdBySubject: string }) => {
        const job: FakeJob = {
          id: 'job-' + (++counter),
          projectId: input.projectId,
          sourceId: input.sourceId,
          status: 'queued',
          attemptNumber: input.attemptNumber,
          triggerType: input.triggerType,
          createdBySubject: input.createdBySubject,
          createdAt: new Date(counter * 1000).toISOString(),
          updatedAt: new Date(counter * 1000).toISOString(),
        };
        jobs.push(job);
        state.activeJob = job;
        return job;
      },
      markProcessing: async (id: string, at: string) => {
        const j = jobs.find((x) => x.id === id)!;
        j.status = 'processing';
        j.startedAt = at;
      },
      markCompleted: async (id: string, at: string) => {
        const j = jobs.find((x) => x.id === id)!;
        j.status = 'completed';
        j.completedAt = at;
        state.activeJob = null;
      },
      markFailed: async (id: string, at: string, code: string, message: string) => {
        const j = jobs.find((x) => x.id === id)!;
        j.status = 'failed';
        j.failedAt = at;
        j.errorCode = code;
        j.errorMessage = message;
        state.activeJob = null;
      },
      saveOutput: async (input: Record<string, unknown>) => {
        const row = { id: 'out-' + (outputs.length + 1), contentType: 'text/plain', createdAt: new Date().toISOString(), ...input };
        outputs.push(row);
        return row as never;
      },
      latestOutput: async () => (outputs[outputs.length - 1] as never) ?? null,
    } as never,
  };
}

function sourceReader(material: unknown, sourceType = 'text', status = 'registered') {
  return {
    getSource: async () => ({ id: 's1', projectId: 'p1', sourceType, status }),
    readRawMaterial: async () => material,
  } as never;
}

const service = (persistence: unknown, sources: unknown) =>
  new IngestionService({
    persistence: persistence as never,
    sources: sources as never,
    router: new SourceAcquisitionRouter([
      createTextAcquisitionAdapter(sources as never),
      createFileAcquisitionAdapter(sources as never),
    ]),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });

test('text source: queued -> processing -> completed with a persisted output', async () => {
  const fp = fakePersistence();
  const svc = service(fp.persistence, sourceReader({ kind: 'text', text: 'مرحبا\r\n\r\n\r\nعالم' }));
  const out = await svc.ingest({ projectId: 'p1', sourceId: 's1', actor: 'actor-1' });

  assert.equal(out.reused, false);
  assert.equal(out.job.status, 'completed');
  assert.equal(fp.jobs.length, 1);
  assert.equal(fp.jobs[0].status, 'completed');
  assert.equal(fp.jobs[0].triggerType, 'manual');
  assert.equal(fp.jobs[0].attemptNumber, 1);
  assert.ok(fp.jobs[0].startedAt && fp.jobs[0].completedAt);
  assert.equal(fp.outputs.length, 1);
  assert.equal(fp.outputs[0].normalizedText, 'مرحبا\n\nعالم');
  assert.match(String(fp.outputs[0].contentSha256), /^[0-9a-f]{64}$/);
});

test('idempotency: an active job is reused, never duplicated', async () => {
  const active: FakeJob = {
    id: 'job-active', projectId: 'p1', sourceId: 's1', status: 'processing',
    attemptNumber: 1, triggerType: 'manual', createdBySubject: 'a', createdAt: 'x', updatedAt: 'x',
  };
  const fp = fakePersistence({ activeJob: active });
  const out = await service(fp.persistence, sourceReader({ kind: 'text', text: 'x' })).ingest({
    projectId: 'p1', sourceId: 's1', actor: 'actor-1',
  });
  assert.equal(out.reused, true);
  assert.equal(out.reason, 'INGESTION_ALREADY_RUNNING');
  assert.equal(out.job.id, 'job-active');
  assert.equal(fp.jobs.length, 0, 'no second job was created');
});

test('idempotency: losing the DB race reuses the winner instead of failing', async () => {
  const winner = {
    id: 'job-winner', projectId: 'p1', sourceId: 's1', status: 'queued',
    attemptNumber: 1, triggerType: 'manual', createdBySubject: 'a', createdAt: 'x', updatedAt: 'x',
  };
  let lookups = 0;
  const persistence = {
    findActiveJob: async () => (++lookups > 1 ? winner : null),
    getJob: async () => winner,
    latestJob: async () => null,
    listJobs: async () => [],
    listLatestJobsByProject: async () => [],
    nextAttemptNumber: async () => 1,
    createJob: async () => {
      throw new ActiveIngestionJobExistsError();
    },
    markProcessing: async () => {},
    markCompleted: async () => {},
    markFailed: async () => {},
    saveOutput: async () => ({}) as never,
    latestOutput: async () => null,
  };
  const out = await service(persistence, sourceReader({ kind: 'text', text: 'x' })).ingest({
    projectId: 'p1', sourceId: 's1', actor: 'a',
  });
  assert.equal(out.reused, true);
  assert.equal(out.job.id, 'job-winner');
});

test('pre-flight failures are typed and create no job', async () => {
  const cases: Array<[string, unknown, string, string]> = [
    ['SOURCE_NOT_FOUND', null, 'text', 'registered'],
    ['SOURCE_ARCHIVED', { kind: 'text', text: 'x' }, 'text', 'archived'],
    ['UNSUPPORTED_SOURCE_TYPE', { kind: 'text', text: 'x' }, 'github', 'registered'],
  ];
  for (const c of cases) {
    const expected = c[0];
    const material = c[1];
    const type = c[2];
    const status = c[3];
    const fp = fakePersistence();
    const reader = {
      getSource: async () => (expected === 'SOURCE_NOT_FOUND' ? null : { id: 's1', projectId: 'p1', sourceType: type, status }),
      readRawMaterial: async () => material,
    };
    await assert.rejects(
      () => service(fp.persistence, reader).ingest({ projectId: 'p1', sourceId: 's1', actor: 'a' }),
      (e: IngestionFailure) => e.code === expected,
      expected,
    );
    assert.equal(fp.jobs.length, 0, expected + ' must not create a job');
  }
});

test('missing raw material fails the job with RAW_ARTIFACT_MISSING', async () => {
  const fp = fakePersistence();
  const out = await service(fp.persistence, sourceReader(null)).ingest({ projectId: 'p1', sourceId: 's1', actor: 'a' });
  assert.equal(out.job.status, 'failed');
  assert.equal(out.job.errorCode, 'RAW_ARTIFACT_MISSING');
  assert.equal(fp.jobs[0].status, 'failed');
  assert.equal(fp.outputs.length, 0);
});

test('file source: TXT normalizes; binary PDF fails explicitly with no fake text', async () => {
  const txtBytes = new TextEncoder().encode('hello\r\n\r\n\r\nworld');
  const fpOk = fakePersistence();
  const okOut = await service(fpOk.persistence, sourceReader({ kind: 'file', bytes: txtBytes, originalName: 'note.txt' }, 'file')).ingest({
    projectId: 'p1', sourceId: 's1', actor: 'a',
  });
  assert.equal(okOut.job.status, 'completed');
  assert.equal(fpOk.outputs[0].normalizedText, 'hello\n\nworld');

  const pdfBytes = new TextEncoder().encode('%PDF-1.4 binary');
  const fpBad = fakePersistence();
  const badOut = await service(fpBad.persistence, sourceReader({ kind: 'file', bytes: pdfBytes, originalName: 'doc.pdf' }, 'file')).ingest({
    projectId: 'p1', sourceId: 's1', actor: 'a',
  });
  assert.equal(badOut.job.status, 'failed');
  assert.equal(badOut.job.errorCode, 'ACQUISITION_FAILED');
  assert.equal(fpBad.outputs.length, 0, 'no output for an unsupported format');
});

test('retry creates a new attempt and can succeed after a failure', async () => {
  const fp = fakePersistence();
  const first = await service(fp.persistence, sourceReader(null)).ingest({ projectId: 'p1', sourceId: 's1', actor: 'a' });
  assert.equal(first.job.status, 'failed');

  const second = await service(fp.persistence, sourceReader({ kind: 'text', text: 'recovered' })).retry('p1', 's1', 'a');
  assert.equal(second.reused, false);
  assert.equal(second.job.status, 'completed');
  assert.equal(second.job.attemptNumber, 2);
  assert.equal(second.job.triggerType, 'retry');
  assert.equal(fp.jobs.length, 2, 'a deliberate retry creates a new attempt row');
});

test('router: only registered source types are supported', () => {
  const reader = sourceReader({ kind: 'text', text: 'x' });
  const router = new SourceAcquisitionRouter([createTextAcquisitionAdapter(reader), createFileAcquisitionAdapter(reader)]);
  assert.deepEqual([...router.supportedTypes()].sort(), ['file', 'text']);
  assert.equal(router.supports('url'), false, 'URL acquisition is a later slice');
  assert.equal(router.supports('github'), false, 'GitHub acquisition is a later slice');
});
