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
import type { SkillDefinition, SkillExecutionResult, SkillExecutionContext, SkillModelCapability, SkillKnowledgeCapability, SkillTraceSummary } from './skill.ts';
import { SkillFailure } from './skill.ts';
import type { SkillRegistry } from './skill-registry.ts';
import type { ModelGateway, ModelGatewayInput } from '../model-gateway/model-gateway.ts';
import type { DecisionRequirement, KnownContextItem, ReadinessResult } from '../readiness/readiness.ts';

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
  /**
   * Project-scoped Knowledge capability factory for Skills that declare knowledge:true.
   * The factory binds the project id, so a Skill can never reach another project.
   */
  knowledge?: (projectId: string) => SkillKnowledgeCapability;
  /** K22 Decision Readiness evaluator for Skills that declare readiness requirements. */
  readiness?: { evaluate(input: { requirements: DecisionRequirement[]; known: KnownContextItem[] }): ReadinessResult };
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

    // Project-scoped Knowledge retrieval (only when declared). The project id is
    // bound HERE, so the Skill cannot widen or cross the project boundary.
    if (skill.requirements.knowledge) {
      if (!this.deps.knowledge) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'knowledge required but not wired');
      ctx.knowledge = this.deps.knowledge(input.projectId);
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

    // K22 Decision Readiness gate — the code-level boundary. If the skill declares
    // readiness requirements and they are not satisfied, the body MUST NOT execute.
    if (skill.readiness) {
      if (!this.deps.readiness) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'readiness required but not wired');
      const payloadObj = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? (input.payload as Record<string, unknown>) : {};
      const userContext = payloadObj.context && typeof payloadObj.context === 'object' && !Array.isArray(payloadObj.context) ? (payloadObj.context as Record<string, unknown>) : {};
      const known: KnownContextItem[] = [
        ...memory.map((m) => ({ key: m.memoryKey, value: (m.payload as Record<string, unknown>).value, source: 'memory' as const })),
        ...Object.entries(userContext).map(([key, value]) => ({ key, value, source: 'user' as const })),
      ];
      const readiness: ReadinessResult = this.deps.readiness.evaluate({ requirements: skill.readiness.requirements, known });
      ctx.readiness = readiness;
      if (readiness.status !== 'READY_FOR_DECISION') {
        return { status: 'needs_information', skillId: skill.id, skillVersion: skill.version, runId, readiness };
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
    // A skill that declares NO static readiness requirements may still reason about
    // its OWN material requirements and return the verdict it computed (K22 stays the
    // only readiness evaluator). It may also attach a bounded admin trace.
    const lifted = liftFromOutput(output);
    return {
      status: 'completed',
      skillId: skill.id,
      skillVersion: skill.version,
      runId,
      output,
      ...(ctx.readiness ? { readiness: ctx.readiness } : lifted.readiness ? { readiness: lifted.readiness } : {}),
      ...(lifted.trace ? { trace: lifted.trace } : {}),
    };
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

// ---------------------------------------------------------------------------
// Bounded lift of skill-provided structured state (never raw model reasoning).
// ---------------------------------------------------------------------------

const READINESS_STATUSES = ['READY_FOR_DECISION', 'NEEDS_INFORMATION', 'INSUFFICIENT_CONTEXT'] as const;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

const strList = (v: unknown, max: number, maxLen: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, max).map((x) => x.trim().slice(0, maxLen));
  return out.length ? out : undefined;
};

/**
 * A skill may return `{ readiness?, trace? }` inside its output. This narrows and
 * bounds both so nothing but auditable references can reach the conversation/trace:
 * no prompts, no chain-of-thought, no raw model text.
 */
function liftFromOutput(output: unknown): { readiness?: ReadinessResult; trace?: SkillTraceSummary } {
  const o = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
  const out: { readiness?: ReadinessResult; trace?: SkillTraceSummary } = {};

  const r = o.readiness;
  if (r && typeof r === 'object') {
    const rr = r as Record<string, unknown>;
    const status = str(rr.status, 40);
    if (status && (READINESS_STATUSES as readonly string[]).includes(status)) {
      const missing = Array.isArray(rr.missing)
        ? (rr.missing as Array<Record<string, unknown>>)
            .filter((m) => m && typeof m === 'object' && typeof m.key === 'string')
            .slice(0, 12)
            .map((m) => ({
              key: String(m.key).slice(0, 64),
              description: str(m.description, 300) ?? String(m.key).slice(0, 64),
              ...(m.question && typeof m.question === 'object'
                ? (() => {
                    const q = m.question as Record<string, unknown>;
                    const wording = str(q.wording, 300);
                    return wording ? { question: { key: String(m.key).slice(0, 64), wording } } : {};
                  })()
                : {}),
              ...(m.interaction && typeof m.interaction === 'object'
                ? (() => {
                    const i = m.interaction as Record<string, unknown>;
                    const type = str(i.type, 24);
                    const options = strList(i.options, 8, 80);
                    return type
                      ? { interaction: { type, ...(options ? { options } : {}), ...(typeof i.allowOther === 'boolean' ? { allowOther: i.allowOther } : {}) } }
                      : {};
                  })()
                : {}),
            }))
        : [];
      out.readiness = {
        status: status as ReadinessResult['status'],
        satisfied: strList(rr.satisfied, 12, 64) ?? [],
        missing,
        ...(rr.nextQuestion && typeof rr.nextQuestion === 'object'
          ? (() => {
              const q = rr.nextQuestion as Record<string, unknown>;
              const wording = str(q.wording, 300);
              const key = str(q.key, 64);
              return wording && key ? { nextQuestion: { key, wording } } : {};
            })()
          : {}),
        knownContextUsed: typeof rr.knownContextUsed === 'number' ? rr.knownContextUsed : 0,
      } as ReadinessResult;
    }
  }

  const t = o.trace;
  if (t && typeof t === 'object') {
    const tt = t as Record<string, unknown>;
    const evidence = Array.isArray(tt.evidence)
      ? (tt.evidence as Array<Record<string, unknown>>)
          .filter((e) => e && typeof e === 'object' && typeof e.chunkId === 'string' && typeof e.sourceId === 'string')
          .slice(0, 12)
          .map((e) => ({ chunkId: String(e.chunkId).slice(0, 64), sourceId: String(e.sourceId).slice(0, 64), ...(str(e.note, 120) ? { note: str(e.note, 120)! } : {}) }))
      : undefined;
    const trace: SkillTraceSummary = {
      ...(str(tt.issue, 300) ? { issue: str(tt.issue, 300)! } : {}),
      ...(str(tt.status, 60) ? { status: str(tt.status, 60)! } : {}),
      ...(strList(tt.approvedSourceIds, 10, 64) ? { approvedSourceIds: strList(tt.approvedSourceIds, 10, 64)! } : {}),
      ...(evidence && evidence.length ? { evidence } : {}),
      ...(strList(tt.requirementKeys, 12, 64) ? { requirementKeys: strList(tt.requirementKeys, 12, 64)! } : {}),
      ...(strList(tt.notes, 6, 200) ? { notes: strList(tt.notes, 6, 200)! } : {}),
    };
    if (Object.keys(trace).length > 0) out.trace = trace;
  }

  return out;
}
