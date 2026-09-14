/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-ingestion
 * @feature K0-011
 * @purpose Ingestion orchestration: queued -> processing -> completed|failed.
 *
 * Authorization is NOT here - the API layer authorizes through the canonical
 * ProjectBoundary, so exactly one authorization path exists. This service owns
 * the processing lifecycle and its idempotency rule:
 *   a source may have at most ONE active (queued|processing) job; a repeat
 *   request reuses that job instead of creating concurrent work.
 *
 * Execution is intentionally synchronous and in-process: no queue, no worker.
 */

import { normalizeText } from './normalize.ts';
import { IngestionFailure, userMessage } from './ingestion.types.ts';
import type { IngestionErrorCode, IngestionJob, IngestionOutput, IngestionTrigger } from './ingestion.types.ts';
import { ActiveIngestionJobExistsError } from './ingestion.ports.ts';
import type { IngestionPersistence, IngestionSourceReader } from './ingestion.ports.ts';
import type { SourceAcquisitionRouter } from './acquisition-router.ts';

export interface IngestionObservation {
  event: 'ingestion.started' | 'ingestion.completed' | 'ingestion.failed' | 'ingestion.reused';
  projectId: string;
  sourceId: string;
  jobId: string;
  sourceType: string;
  attemptNumber: number;
  result: string;
  errorCode?: string;
  durationMs?: number;
}

export interface IngestionServiceDeps {
  persistence: IngestionPersistence;
  sources: IngestionSourceReader;
  router: SourceAcquisitionRouter;
  now?: () => Date;
  /** Structured, content-free observability sink. */
  observer?: (event: IngestionObservation) => void;
}

export interface IngestOutcome {
  job: IngestionJob;
  /** True when an existing active job was returned instead of starting new work. */
  reused: boolean;
  reason?: IngestionErrorCode;
  output?: IngestionOutput;
}

export class IngestionService {
  constructor(private readonly deps: IngestionServiceDeps) {}

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  async ingest(input: {
    projectId: string;
    sourceId: string;
    actor: string;
    trigger?: IngestionTrigger;
  }): Promise<IngestOutcome> {
    const { projectId, sourceId, actor } = input;
    const trigger: IngestionTrigger = input.trigger ?? 'manual';
    const { persistence, sources, router, observer } = this.deps;

    // 1) Idempotency fast path: an active job already owns this source.
    const active = await persistence.findActiveJob(projectId, sourceId);
    if (active) {
      observer?.({
        event: 'ingestion.reused',
        projectId,
        sourceId,
        jobId: active.id,
        sourceType: 'unknown',
        attemptNumber: active.attemptNumber,
        result: 'reused',
      });
      return { job: active, reused: true, reason: 'INGESTION_ALREADY_RUNNING' };
    }

    // 2) Pre-flight: explicit typed failures. No job is created for these.
    const source = await sources.getSource(projectId, sourceId);
    if (!source) throw new IngestionFailure('SOURCE_NOT_FOUND');
    if (source.status === 'archived') throw new IngestionFailure('SOURCE_ARCHIVED');
    if (!router.supports(source.sourceType)) throw new IngestionFailure('UNSUPPORTED_SOURCE_TYPE');

    // 3) Create the job. The database partial unique index is the real guard: a
    //    racing request loses here and reuses the winner's job.
    const attemptNumber = await persistence.nextAttemptNumber(projectId, sourceId);
    let job: IngestionJob;
    try {
      job = await persistence.createJob({
        projectId,
        sourceId,
        attemptNumber,
        triggerType: trigger,
        createdBySubject: actor,
      });
    } catch (err) {
      if (err instanceof ActiveIngestionJobExistsError) {
        const winner = await persistence.findActiveJob(projectId, sourceId);
        if (winner) return { job: winner, reused: true, reason: 'INGESTION_ALREADY_RUNNING' };
      }
      throw new IngestionFailure('INTERNAL_ERROR');
    }

    const startedAt = this.nowIso();
    await persistence.markProcessing(job.id, startedAt);
    const startedMs = Date.now();
    observer?.({
      event: 'ingestion.started',
      projectId,
      sourceId,
      jobId: job.id,
      sourceType: source.sourceType,
      attemptNumber,
      result: 'processing',
    });

    try {
      const acquired = await router.acquire({ projectId, sourceId, sourceType: source.sourceType });

      let normalized;
      try {
        normalized = normalizeText(acquired.text);
      } catch {
        throw new IngestionFailure('NORMALIZATION_FAILED');
      }

      const output = await persistence.saveOutput({
        projectId,
        ingestionJobId: job.id,
        sourceId,
        normalizedText: normalized.text,
        contentSha256: normalized.sha256,
        charCount: normalized.charCount,
      });

      const completedAt = this.nowIso();
      await persistence.markCompleted(job.id, completedAt);
      observer?.({
        event: 'ingestion.completed',
        projectId,
        sourceId,
        jobId: job.id,
        sourceType: source.sourceType,
        attemptNumber,
        result: 'completed',
        durationMs: Date.now() - startedMs,
      });
      return {
        job: { ...job, status: 'completed', startedAt, completedAt },
        reused: false,
        output,
      };
    } catch (err) {
      const code: IngestionErrorCode = err instanceof IngestionFailure ? err.code : 'ACQUISITION_FAILED';
      const message = userMessage(code);
      const failedAt = this.nowIso();
      await persistence.markFailed(job.id, failedAt, code, message);
      observer?.({
        event: 'ingestion.failed',
        projectId,
        sourceId,
        jobId: job.id,
        sourceType: source.sourceType,
        attemptNumber,
        result: 'failed',
        errorCode: code,
        durationMs: Date.now() - startedMs,
      });
      // Execution failures are reported through the job, not as an HTTP error.
      return {
        job: { ...job, status: 'failed', startedAt, failedAt, errorCode: code, errorMessage: message },
        reused: false,
      };
    }
  }

  /** A deliberate new run. Reuses an active job; otherwise creates attempt N+1. */
  retry(projectId: string, sourceId: string, actor: string): Promise<IngestOutcome> {
    return this.ingest({ projectId, sourceId, actor, trigger: 'retry' });
  }

  getJob(projectId: string, jobId: string): Promise<IngestionJob | null> {
    return this.deps.persistence.getJob(projectId, jobId);
  }

  listForSource(projectId: string, sourceId: string): Promise<IngestionJob[]> {
    return this.deps.persistence.listJobs(projectId, sourceId);
  }

  listLatestByProject(projectId: string): Promise<IngestionJob[]> {
    return this.deps.persistence.listLatestJobsByProject(projectId);
  }
}
