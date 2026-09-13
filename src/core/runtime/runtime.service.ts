/**
 * @kip
 * @module runtime
 * @layer core
 * @owner platform-core
 * @feature K0-002
 * @purpose Executable platform runtime spine: one path from trusted actor to run result.
 */

import type { Actor } from '../authorization/actor.ts';
import type { CapabilityLookup } from '../capability/capability.ts';
import type { ErrorCategory, RunStatus } from '../run/run.ts';
import type { RunError } from './runtime.ts';
import type { RuntimePersistence, RunRecord } from './runtime.ports.ts';
import { emitLifecycle } from './runtime.observability.ts';

export interface RunResult {
  id: string;
  status: 'completed' | 'failed';
  output?: unknown;
}

export type ExecuteResult = RunResult | { error: RunError };

export interface ExecuteContext {
  projectId: string;
  actor: Actor;
  capability: string;
  input?: unknown;
}

function makeError(kind: RunError['kind'], message: string, code: string): RunError {
  return { kind, code, message } as RunError;
}

/**
 * Executes one traceable unit of work through the platform spine.
 * Pre-execution failures (missing/archived project, unauthorized actor,
 * unknown capability) return a controlled error WITHOUT creating a Run.
 */
export class RuntimeService {
  constructor(
    private readonly persistence: RuntimePersistence,
    private readonly capabilityLookup: CapabilityLookup,
  ) {}

  async execute(ctx: ExecuteContext): Promise<ExecuteResult> {
    const project = await this.persistence.getProject(ctx.projectId);
    if (!project) {
      return { error: makeError('not_found', 'project not found', 'PROJECT_NOT_FOUND') };
    }
    if (project.status !== 'active') {
      return { error: makeError('validation', 'project is not active', 'PROJECT_NOT_ACTIVE') };
    }

    const membership = await this.persistence.getMembership(ctx.projectId, ctx.actor);
    if (!membership) {
      return { error: makeError('authorization', 'actor is not a member', 'NOT_AUTHORIZED') };
    }

    const handler = await this.capabilityLookup.get(ctx.capability);
    if (!handler) {
      return { error: makeError('not_found', 'capability not found', 'CAPABILITY_NOT_FOUND') };
    }

    const run: RunRecord = {
      id: crypto.randomUUID(),
      projectId: ctx.projectId,
      actorSubject: ctx.actor,
      capability: ctx.capability,
      status: 'started',
      startedAt: new Date().toISOString(),
    };
    await this.persistence.createRun(run);
    emitLifecycle(run);

    try {
      const output = await handler({ projectId: ctx.projectId, capability: ctx.capability, input: ctx.input });
      return await this.complete(run, output);
    } catch (err) {
      return await this.fail(run, err);
    }
  }

  private async complete(run: RunRecord, output: unknown): Promise<RunResult> {
    const completedAt = new Date().toISOString();
    const patch = { status: 'completed' as RunStatus, completedAt, latencyMs: latency(run.startedAt, completedAt) };
    await this.persistence.updateRun(run.id, patch);
    const done: RunRecord = { ...run, ...patch };
    emitLifecycle(done);
    return { id: run.id, status: 'completed', output };
  }

  private async fail(run: RunRecord, err: unknown): Promise<RunResult> {
    const completedAt = new Date().toISOString();
    const category: ErrorCategory = 'runtime';
    const patch = { status: 'failed' as RunStatus, completedAt, latencyMs: latency(run.startedAt, completedAt), errorCategory: category };
    await this.persistence.updateRun(run.id, patch);
    const done: RunRecord = { ...run, ...patch };
    emitLifecycle(done);
    return { id: run.id, status: 'failed' };
  }
}

function latency(startedAt: string, completedAt: string): number {
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}