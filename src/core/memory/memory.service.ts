/**
 * @kip
 * @module memory
 * @layer core
 * @owner intelligence-knowledge
 * @feature K18
 * @purpose One focused Memory Service over the generic memory records port.
 */

import {
  ACTIVE,
  ARCHIVED,
  DEFAULT_RELEVANT_LIMIT,
  MAX_RELEVANT_LIMIT,
  MemoryFailure,
  SUPERSEDED,
  isMemoryScope,
  type ArchiveInput,
  type MemoryRecord,
  type RecallInput,
  type RelevantMemoryQuery,
  type RememberInput,
  type SupersedeInput,
} from './memory.ts';

export interface MemoryStoragePort {
  remember(input: RememberInput): Promise<MemoryRecord>;
  /** Only ACTIVE records. */
  recallActive(input: RecallInput): Promise<MemoryRecord[]>;
  /** Any status, for history/audit (explicitly requested). */
  history(input: RecallInput): Promise<MemoryRecord[]>;
  /**
   * Atomically supersede: mark the current ACTIVE record(s) for the logical memory
   * as SUPERSEDED and insert the new ACTIVE one. Returns the new active record.
   */
  supersede(input: SupersedeInput): Promise<MemoryRecord>;
  /** Move one record (project-scoped) to ARCHIVED without deleting history. */
  archive(input: ArchiveInput): Promise<MemoryRecord | null>;
  /** Deterministic, bounded, active-only relevant retrieval. */
  retrieveRelevant(query: RelevantMemoryQuery): Promise<MemoryRecord[]>;
}

function validateRemember(input: RememberInput): void {
  if (!isMemoryScope(input.scope)) throw new MemoryFailure('MEMORY_SCOPE_INVALID', String(input.scope));
  if (typeof input.subjectId !== 'string' || input.subjectId.trim().length === 0) {
    throw new MemoryFailure('MEMORY_CONTRACT_INVALID', 'subjectId required');
  }
  if (typeof input.memoryType !== 'string' || input.memoryType.trim().length === 0) {
    throw new MemoryFailure('MEMORY_CONTRACT_INVALID', 'memoryType required');
  }
  if (typeof input.memoryKey !== 'string' || input.memoryKey.trim().length === 0) {
    throw new MemoryFailure('MEMORY_CONTRACT_INVALID', 'memoryKey required');
  }
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new MemoryFailure('MEMORY_CONTRACT_INVALID', 'payload must be a JSON object');
  }
}

export class MemoryService {
  constructor(private readonly persistence: MemoryStoragePort) {}

  async remember(input: RememberInput): Promise<MemoryRecord> {
    validateRemember(input);
    return this.persistence.remember(input);
  }

  async recall(input: RecallInput): Promise<MemoryRecord[]> {
    return this.persistence.recallActive(input);
  }

  async history(input: RecallInput): Promise<MemoryRecord[]> {
    return this.persistence.history(input);
  }

  async supersede(input: SupersedeInput): Promise<MemoryRecord> {
    validateRemember(input);
    return this.persistence.supersede(input);
  }

  async archive(input: ArchiveInput): Promise<MemoryRecord | null> {
    return this.persistence.archive(input);
  }

  /** Bounded, active-only, deterministic relevant retrieval. */
  async retrieveRelevant(query: RelevantMemoryQuery): Promise<MemoryRecord[]> {
    const limit = query.limit === undefined ? DEFAULT_RELEVANT_LIMIT : Math.min(Math.max(1, Math.trunc(query.limit)), MAX_RELEVANT_LIMIT);
    return this.persistence.retrieveRelevant({ ...query, limit });
  }
}

export { ACTIVE, ARCHIVED, SUPERSEDED, DEFAULT_RELEVANT_LIMIT, MAX_RELEVANT_LIMIT };
