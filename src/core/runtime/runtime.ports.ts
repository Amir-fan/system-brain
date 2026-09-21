/**
 * @kip
 * @module runtime
 * @layer core
 * @owner platform-core
 * @feature K0-002
 * @purpose Persistence and capability ports consumed by the runtime spine.
 */

import type { Actor, ProjectMembership } from '../authorization/actor.ts';
import type { Project } from '../project/project.ts';
import type { ErrorCategory, RunStatus } from '../run/run.ts';

export interface RunRecord {
  id: string;
  projectId: string;
  actorSubject?: string;
  capability: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  errorCategory?: ErrorCategory;
  providerKey?: string;
  modelName?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number };
}

export interface RuntimePersistence {
  getProject(projectId: string): Promise<Project | null>;
  getMembership(projectId: string, actor: Actor): Promise<ProjectMembership | null>;
  /**
   * Trusted provisioning primitive (Stage 3): idempotently ensure a membership exists.
   * Never downgrades an existing row. Authorization is the caller's responsibility.
   */
  ensureMembership?(projectId: string, actor: Actor, role: ProjectMembership['role']): Promise<ProjectMembership>;
  createRun(record: RunRecord): Promise<void>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
}