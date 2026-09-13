/**
 * @kip
 * @module runtime
 * @layer core
 * @owner platform-core
 * @feature K0-002
 * @purpose Run lifecycle structured observability (log-only; no persistence, no vendor).
 */

import type { RunLifecycleEvent } from '../run/run.ts';
import type { RunRecord } from './runtime.ports.ts';

export interface RuntimeEvent {
  event: RunLifecycleEvent;
  runId: string;
  projectId: string;
  actorSubject?: string;
  capability: string;
}

/** Structured lifecycle signal. Redacts run content; only trace metadata. */
export function emitLifecycle(record: RunRecord): void {
  const evt: RuntimeEvent = {
    event: toLifecycleEvent(record.status),
    runId: record.id,
    projectId: record.projectId,
    actorSubject: record.actorSubject,
    capability: record.capability,
  };
  console.log(JSON.stringify(evt));
}

function toLifecycleEvent(status: RunRecord['status']): RunLifecycleEvent {
  switch (status) {
    case 'completed':
      return 'run.completed';
    case 'failed':
      return 'run.failed';
    default:
      return 'run.started';
  }
}