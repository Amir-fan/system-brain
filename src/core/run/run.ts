/**
 * @kip
 * @module run
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Canonical Run status, trace, and lifecycle signals.
 */

import type { ModelUsage } from '../model-gateway/model-gateway.ts';

export const RUN_STATUSES = ['started', 'completed', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type ErrorCategory = 'validation' | 'authorization' | 'not_found' | 'provider' | 'runtime';

/** One traceable unit of work inside KIP. */
export interface RunTrace {
  runId: string;
  projectId: string;
  actorSubject?: string;
  capability: string;
  status: RunStatus;
  provider?: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  errorCategory?: ErrorCategory;
  usage?: ModelUsage;
}

export const RUN_LIFECYCLE_EVENTS = ['run.started', 'run.completed', 'run.failed'] as const;
export type RunLifecycleEvent = (typeof RUN_LIFECYCLE_EVENTS)[number];