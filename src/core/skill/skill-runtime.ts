/**
 * @kip
 * @module skill
 * @layer core
 * @owner intelligence-knowledge
 * @feature K20
 * @purpose Skills Runtime: resolve, validate, gate, execute and track a Skill
 *          through the existing Run lifecycle (same `runs` table + persistence
 *          port — no new table, no second generic runtime).
 */

import { authorizeProject } from '../authorization/project-boundary.ts';
import type { ProjectBoundaryReaders } from '../authorization/project-boundary.ts';
import type { RuntimePersistence, RunRecord } from '../runtime/runtime.ports.ts';
import type { Actor } from '../authorization/actor.ts';
import type { UnderstandingService } from '../understanding/understanding.service.ts';
import type { BoundedUnderstandingContext, UnderstandingInput, UnderstandingResult } from '../understanding/understanding.ts';
import type { MemoryReference } from '../understanding/understanding.ts';
import type { SkillDefinition, SkillExecutionResult, SkillExecutionContext, SkillModelCapability } from './skill.ts';
import { SkillFailure } from './skill.ts';
import type { SkillRegistry } from './skill-registry.ts';
import type { ModelGateway, ModelGatewayInput } from '../model-gateway/model-gateway.ts';

export interface SkillRuntimeDeps {
  persistence: RuntimePersistence & ProjectBoundaryReaders;
  registry: SkillRegistry;
  /** Existing K19 Understanding service (only used when a Skill declares it). */
  understanding?: Pick<UnderstandingService, 'evaluate'>;
  /** Bounded memory via the existing MemoryService (only used when a Skill declares it). */
  memory?: {
    fetchBounded(projectId: string, ids: { subjectId?: string; conversationId?: string; caseId?: string }): Promise<BoundedUnderstandingContext>;
  };
  /** Existing Model Gateway (resolving gateway) for Skills that declare model:true. */
  modelGateway?: ModelGateway;
}

export interface SkillExecutionInput {
  projectId: string;
  actor: string;
  skillId: string;
  payload: unknown;
  subjectId?: string;
  conversationId?: string;
  caseId?: string;
  requestTimestamp?: string;
}

const CAPABILITY = 'k20.skills-runtime';

function failed(skill: SkillDefinition, runId: string, code: SkillFailure['code'], message: string): SkillExecutionResult {
  return { status: 'failed', skillId: skill.id, skillVersion: skill.version, runId, error: { code, message } };
}

export class SkillsRuntime {
  constructor(private readonly deps: SkillRuntimeDeps) {}

  async execute(input: SkillExecutionInput): Promise<SkillExecutionResult> {
    const decision = await authorizeProject(this.deps.persistence, input.projectId, input.actor, 'write');
    if (!decision.ok) {
      const reason = decision.kind === 'not_found' ? 'project not found' : decision.kind === 'not_active' ? 'project is not active' : 'not authorized';
      throw new SkillFailure('SKILL_NOT_FOUND', reason);
    }

    const skill = this.deps.registry.get(input.skillId);
    if (!skill) throw new SkillFailure('SKILL_NOT_FOUND', input.skillId);

    const validation = skill.validateInput(input.payload);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    if (!validation.ok) {
      await this.openRun(input, runId, skill, startedAt);
      await this.failRun(runId, startedAt, 'validation');
      return failed(skill, runId, 'SKILL_INVALID_INPUT', validation.message);
    }

    await this.openRun(input, runId, skill, startedAt);
    try {
      const result = await this.executeSkill(input, skill, runId);
      await this.completeRun(runId, startedAt);
      return result;
    } catch (err) {
      await this.failRun(runId, startedAt, err instanceof SkillFailure ? 'validation' : 'runtime');
      throw err;
    }
  }

  private async executeSkill(input: SkillExecutionInput, skill: SkillDefinition, runId: string): Promise<SkillExecutionResult> {
    const ctx: SkillExecutionContext = { projectId: input.projectId, actor: input.actor, input: input.payload };

    // Bounded memory (only when declared).
    let memory: MemoryReference[] = [];
    if (skill.requirements.memory) {
      if (!this.deps.memory) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'memory required but not wired');
      const ids = { subjectId: input.subjectId, conversationId: input.conversationId, caseId: input.caseId };
      const bounded = await this.deps.memory.fetchBounded(input.projectId, ids);
      memory = [...bounded.user, ...bounded.conversation, ...bounded.case];
      ctx.memory = memory;
    }

    // Structured Understanding (only when declared) — reused from K19, never reimplemented.
    if (skill.requirements.understanding) {
      if (!this.deps.understanding) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'understanding required but not wired');
      const p = (input.payload ?? {}) as Record<string, unknown>;
      const text: string = typeof p.text === 'string' ? p.text : '';
      const uInput: UnderstandingInput = {
        projectId: input.projectId,
        text,
        ...(input.subjectId ? { subjectId: input.subjectId } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.caseId ? { caseId: input.caseId } : {}),
        ...(input.requestTimestamp ? { requestTimestamp: input.requestTimestamp } : {}),
      };
      const bounded = memory.length > 0 ? await this.boundedForUnderstanding(input) : undefined;
      const understanding: UnderstandingResult = await this.deps.understanding.evaluate({ ...uInput, ...(bounded ? { context: bounded } : {}) });
      ctx.understanding = understanding;

      // AMBIGUITY GATE: a consequential body must not run on an unclear input.
      if (understanding.status === 'NEEDS_CLARIFICATION') {
        return {
          status: 'needs_clarification',
          skillId: skill.id,
          skillVersion: skill.version,
          runId,
          clarification: understanding.clarification,
        };
      }
    }

    // Narrow model capability (only when declared) via the existing gateway.
    if (skill.requirements.model) {
      if (!this.deps.modelGateway) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'model required but not wired');
      const capability: SkillModelCapability = {
        generateText: async ({ workload, parts, message }) => {
          const out = await this.deps.modelGateway!.generateText({
            projectId: input.projectId,
            runId,
            capability: skill.id,
            model: { profile: workload } as ModelGatewayInput['model'],
            input: parts && parts.length > 0 ? { parts } : { message: message ?? '' },
          });
          return { text: out.text, provider: out.provider, model: out.model, usage: out.usage };
        },
      };
      ctx.model = capability;
    }

    const output = await skill.execute(ctx);
    const outputCheck = skill.validateOutput(output);
    if (!outputCheck.ok) {
      // The execute() catch marks the run failed when this rethrows.
      throw new SkillFailure('SKILL_INVALID_OUTPUT', outputCheck.message);
    }
    return { status: 'completed', skillId: skill.id, skillVersion: skill.version, runId, output };
  }

  private async boundedForUnderstanding(input: SkillExecutionInput): Promise<BoundedUnderstandingContext> {
    if (!this.deps.memory) return { user: [], conversation: [], case: [] };
    return this.deps.memory.fetchBounded(input.projectId, {
      subjectId: input.subjectId,
      conversationId: input.conversationId,
      caseId: input.caseId,
    });
  }

  private openRun(input: SkillExecutionInput, runId: string, skill: SkillDefinition, startedAt: string): Promise<void> {
    const run: RunRecord = {
      id: runId,
      projectId: input.projectId,
      actorSubject: input.actor,
      capability: CAPABILITY,
      status: 'started',
      startedAt,
    };
    return this.deps.persistence.createRun(run);
  }

  private async completeRun(runId: string, startedAt: string): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.deps.persistence.updateRun(runId, {
      status: 'completed',
      completedAt,
      latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    });
  }

  private async failRun(runId: string, startedAt: string, errorCategory: 'validation' | 'runtime'): Promise<void> {
    const completedAt = new Date().toISOString();
    await this.deps.persistence.updateRun(runId, {
      status: 'failed',
      completedAt,
      latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      errorCategory,
    });
  }
}
