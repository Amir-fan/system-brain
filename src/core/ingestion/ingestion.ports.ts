/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-ingestion
 * @feature K0-011
 * @purpose Ingestion ports (dependency-inverted boundaries).
 *
 * Core defines what ingestion needs; the platform supplies Supabase-backed
 * implementations and per-source-type acquisition adapters. No ORM, no generic
 * repository, no queue abstraction.
 */

import type {
  AcquiredContent,
  CreateIngestionJobInput,
  IngestionJob,
  IngestionOutput,
  SaveIngestionOutputInput,
} from './ingestion.types.ts';
import type { SourceType } from '../project/source-type.ts';

/** Raised when the database refuses a second active job for the same source. */
export class ActiveIngestionJobExistsError extends Error {
  constructor() {
    super('active ingestion job already exists');
    this.name = 'ActiveIngestionJobExistsError';
  }
}

export interface IngestionPersistence {
  findActiveJob(projectId: string, sourceId: string): Promise<IngestionJob | null>;
  getJob(projectId: string, jobId: string): Promise<IngestionJob | null>;
  latestJob(projectId: string, sourceId: string): Promise<IngestionJob | null>;
  listJobs(projectId: string, sourceId: string): Promise<IngestionJob[]>;
  /** Most recent job per source for a whole project (drives the Knowledge list). */
  listLatestJobsByProject(projectId: string): Promise<IngestionJob[]>;
  nextAttemptNumber(projectId: string, sourceId: string): Promise<number>;
  createJob(input: CreateIngestionJobInput): Promise<IngestionJob>;
  markProcessing(jobId: string, at: string): Promise<void>;
  markCompleted(jobId: string, at: string): Promise<void>;
  markFailed(jobId: string, at: string, errorCode: string, errorMessage: string): Promise<void>;
  saveOutput(input: SaveIngestionOutputInput): Promise<IngestionOutput>;
  latestOutput(projectId: string, sourceId: string): Promise<IngestionOutput | null>;
}

export interface IngestionSourceSummary {
  id: string;
  projectId: string;
  sourceType: SourceType;
  status: string;
}

/** Raw material handed to an adapter. `bytes` is only populated for file artifacts. */
export interface RawMaterial {
  kind: 'text' | 'file';
  text?: string;
  bytes?: Uint8Array;
  mimeType?: string;
  originalName?: string;
}

export interface IngestionSourceReader {
  getSource(projectId: string, sourceId: string): Promise<IngestionSourceSummary | null>;
  /** Null when the source has no raw artifact (reported as RAW_ARTIFACT_MISSING). */
  readRawMaterial(projectId: string, sourceId: string): Promise<RawMaterial | null>;
}

/** One adapter per source type. Adding a source type means adding an adapter. */
export interface SourceAcquisitionAdapter {
  readonly sourceTypes: readonly SourceType[];
  acquire(input: { projectId: string; sourceId: string; sourceType: SourceType }): Promise<AcquiredContent>;
}
