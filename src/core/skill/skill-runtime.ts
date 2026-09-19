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
import type { SkillDefinition, SkillExecutionResult, SkillExecutionContext, SkillModelCapability, SkillKnowledgeCapability, SkillTraceSummary, SkillAnswer, SkillTurnContext, SkillTraceTimings, SkillKnowledgeCallTiming, SkillExecutionTrace, SkillExecutionStage, ExecutionStageName, ExecutionOutcome } from './skill.ts';
import { MAX_SKILL_CONTEXT_REQUIREMENTS, MAX_SKILL_CONTEXT_EVIDENCE, MAX_SKILL_CONTEXT_SOURCES } from './skill.ts';
import { SkillFailure } from './skill.ts';
import { isProviderError } from '../model-gateway/gateway-errors.ts';
import type { ErrorCategory } from '../run/run.ts';
import type { SkillRegistry } from './skill-registry.ts';
import type { ModelGateway, ModelGatewayInput } from '../model-gateway/model-gateway.ts';
import {
  isInteractionType,
  type DecisionRequirement,
  type KnownContextItem,
  type ReadinessResult,
  type RequirementInteraction,
} from '../readiness/readiness.ts';

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

/**
 * Generic per-run timing collector. Measured by the runtime at the capability boundary,
 * never by a Skill, so every Skill is instrumented identically.
 */
interface TurnTimings extends SkillTraceTimings {
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number };
  provider?: string;
  model?: string;
}

function newTimings(): TurnTimings {
  return {
    total_ms: 0,
    context_ms: 0,
    skill_ms: 0,
    persistence_ms: 0,
    model_total_ms: 0,
    model_call_count: 0,
    model_calls: [],
    knowledge_total_ms: 0,
    knowledge_call_count: 0,
    knowledge_calls: [],
    usage: {},
  };
}

function snapshotTimings(t: TurnTimings, totalStart: number): SkillTraceTimings {
  return {
    total_ms: Date.now() - totalStart,
    context_ms: t.context_ms,
    skill_ms: t.skill_ms,
    persistence_ms: t.persistence_ms,
    model_total_ms: t.model_total_ms,
    model_call_count: t.model_calls.length,
    model_calls: t.model_calls,
    knowledge_total_ms: t.knowledge_total_ms,
    knowledge_call_count: t.knowledge_calls.length,
    knowledge_calls: t.knowledge_calls,
  };
}

/**
 * Generic technical markers a Skill may leave in its bounded trace notes. Mapping them to
 * execution stages only REPORTS what already happened — it changes no Skill behaviour and no
 * runtime decision (observability, never steering).
 */
const TECHNICAL_MARKERS: Array<{ marker: string; stage: ExecutionStageName; code: string }> = [
  { marker: 'unreadable_model_output', stage: 'OUTPUT_PARSE', code: 'INVALID_OUTPUT_ENVELOPE' },
  { marker: 'citation_rejected', stage: 'CITATION_VALIDATION', code: 'CITATION_VALIDATION_FAILED' },
  { marker: 'answer_without_tool_evidence', stage: 'CITATION_VALIDATION', code: 'CITATION_VALIDATION_FAILED' },
  { marker: 'answer_without_valid_citation', stage: 'CITATION_VALIDATION', code: 'CITATION_VALIDATION_FAILED' },
  { marker: 'approved_sources_missing', stage: 'CONTEXT', code: 'NO_APPROVED_SOURCES' },
  { marker: 'no_approved_source_evidence_retrieved', stage: 'KNOWLEDGE_SEARCH', code: 'NO_APPROVED_EVIDENCE_RETRIEVED' },
  { marker: 'model_call_bound_reached', stage: 'MODEL_CALL', code: 'TOOL_CALL_LIMIT' },
];

function technicalFailure(markers: string[]): { stage: ExecutionStageName; code: string } | undefined {
  for (const m of markers) {
    const hit = TECHNICAL_MARKERS.find((x) => x.marker === m);
    if (hit) return { stage: hit.stage, code: hit.code };
  }
  return undefined;
}

/** Measured-only trace of a run (durations, counts, statuses, codes — never prompts/reasoning). */
function buildExecutionTrace(args: {
  t: TurnTimings;
  totalStart: number;
  traceStatus?: string;
  markers: string[];
  finalized: boolean;
  citationRan: boolean;
}): SkillExecutionTrace {
  const { t, totalStart, traceStatus, markers, finalized, citationRan } = args;
  const failure = technicalFailure(markers);
  const stages: SkillExecutionStage[] = [];
  stages.push({ stage: 'REQUEST', status: 'SUCCESS' });
  stages.push({ stage: 'CONTEXT', status: 'SUCCESS', duration_ms: t.context_ms });
  t.model_calls.forEach((c) => {
    stages.push({
      stage: 'MODEL_CALL',
      index: c.call_index,
      status: c.timeout ? 'TIMEOUT' : c.status === 'success' ? 'SUCCESS' : 'FAILED',
      duration_ms: c.duration_ms,
      detail: {
        ...(c.provider ? { provider: c.provider } : {}),
        ...(c.model ? { model: c.model } : {}),
        ...(c.input_tokens !== undefined ? { input_tokens: c.input_tokens } : {}),
        ...(c.output_tokens !== undefined ? { output_tokens: c.output_tokens } : {}),
        ...(c.served_by ? { served_by: c.served_by } : {}),
        ...(c.reasoning_tokens !== undefined ? { reasoning_tokens: c.reasoning_tokens } : {}),
        ...(c.finish_reason ? { finish_reason: c.finish_reason } : {}),
        timeout: c.timeout,
      },
    });
  });
  t.knowledge_calls.forEach((c, i) => {
    stages.push({
      stage: 'KNOWLEDGE_SEARCH',
      index: i + 1,
      status: c.status === 'success' ? 'SUCCESS' : 'FAILED',
      duration_ms: c.duration_ms,
      detail: { operation: c.operation },
    });
  });
  stages.push({
    stage: 'OUTPUT_PARSE',
    status: failure?.stage === 'OUTPUT_PARSE' ? 'FAILED' : traceStatus ? 'SUCCESS' : 'SKIPPED',
  });
  stages.push({
    stage: 'CITATION_VALIDATION',
    status: failure?.stage === 'CITATION_VALIDATION' ? 'FAILED' : citationRan ? 'SUCCESS' : 'SKIPPED',
  });
  stages.push({
    stage: 'PERSISTENCE',
    status: finalized ? 'SUCCESS' : 'FAILED',
    duration_ms: t.persistence_ms,
    ...(finalized ? {} : { detail: { errorCode: 'PERSISTENCE_FAILED' } }),
  });
  stages.push({ stage: 'RESPONSE', status: 'SUCCESS' });

  const outcome: ExecutionOutcome = failure
    ? 'TECHNICAL_FAILURE'
    : traceStatus === 'ANSWER'
      ? 'COMPLETED'
      : traceStatus === 'NEED_INFO'
        ? 'ASK_USER'
        : traceStatus === 'INSUFFICIENT_EVIDENCE'
          ? 'INSUFFICIENT_EVIDENCE'
          : 'COMPLETED';

  const slowestStage = [...stages]
    .filter((s) => typeof s.duration_ms === 'number')
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0];

  return {
    outcome,
    stages: stages.slice(0, 24),
    ...(failure ? { failureStage: failure.stage, failureCode: failure.code } : {}),
    ...(finalized ? {} : { failureStage: 'PERSISTENCE', failureCode: 'PERSISTENCE_FAILED' }),
    ...(slowestStage
      ? { slowest: { stage: slowestStage.stage, ...(slowestStage.index ? { index: slowestStage.index } : {}), duration_ms: slowestStage.duration_ms ?? 0 } }
      : {}),
    totals: {
      total_ms: Date.now() - totalStart,
      model_ms: t.model_total_ms,
      knowledge_ms: t.knowledge_total_ms,
      core_ms: t.context_ms + Math.max(0, t.skill_ms - t.model_total_ms - t.knowledge_total_ms),
      persistence_ms: t.persistence_ms,
    },
  };
}

/** Trace for a run that threw (no Skill result exists): the runtime still knows what it measured. */
function buildFailureExecution(
  t: TurnTimings,
  totalStart: number,
  failureStage: ExecutionStageName,
  failureCode: string,
  finalized: boolean,
): SkillExecutionTrace {
  const stages: SkillExecutionStage[] = [{ stage: 'REQUEST', status: 'SUCCESS' }, { stage: 'CONTEXT', status: 'SUCCESS', duration_ms: t.context_ms }];
  t.model_calls.forEach((c) => {
    stages.push({
      stage: 'MODEL_CALL',
      index: c.call_index,
      status: c.timeout ? 'TIMEOUT' : c.status === 'success' ? 'SUCCESS' : 'FAILED',
      duration_ms: c.duration_ms,
      detail: { timeout: c.timeout },
    });
  });
  t.knowledge_calls.forEach((c, i) => {
    stages.push({ stage: 'KNOWLEDGE_SEARCH', index: i + 1, status: c.status === 'success' ? 'SUCCESS' : 'FAILED', duration_ms: c.duration_ms, detail: { operation: c.operation } });
  });
  stages.push({
    stage: failureStage,
    status: failureStage === 'PERSISTENCE' ? 'FAILED' : 'TIMEOUT',
    ...(failureStage === 'PERSISTENCE' ? { duration_ms: t.persistence_ms } : {}),
  });
  if (failureStage !== 'PERSISTENCE') {
    stages.push({ stage: 'PERSISTENCE', status: finalized ? 'SUCCESS' : 'FAILED', duration_ms: t.persistence_ms, ...(finalized ? {} : { detail: { errorCode: 'PERSISTENCE_FAILED' } }) });
  }
  const slowestStage = [...stages].filter((s) => typeof s.duration_ms === 'number').sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0];
  return {
    outcome: 'TECHNICAL_FAILURE',
    stages: stages.slice(0, 24),
    failureStage,
    failureCode,
    ...(slowestStage ? { slowest: { stage: slowestStage.stage, ...(slowestStage.index ? { index: slowestStage.index } : {}), duration_ms: slowestStage.duration_ms ?? 0 } } : {}),
    totals: {
      total_ms: Date.now() - totalStart,
      model_ms: t.model_total_ms,
      knowledge_ms: t.knowledge_total_ms,
      core_ms: t.context_ms + Math.max(0, t.skill_ms - t.model_total_ms - t.knowledge_total_ms),
      persistence_ms: t.persistence_ms,
    },
  };
}

/** A timed-out/aborted provider call is a technical failure, not a reasoning outcome. */
function isTimeoutFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const name = (e as { name?: unknown } | null)?.name;
  return code === 'PROVIDER_CHAT_TIMEOUT' || name === 'TimeoutError' || name === 'AbortError';
}

/** Wrap a project-scoped Knowledge capability so each operation is counted and timed. */
function instrumentKnowledge(cap: SkillKnowledgeCapability, t: TurnTimings): SkillKnowledgeCapability {
  const record = (operation: string, started: number, status: 'success' | 'error'): void => {
    const duration = Date.now() - started;
    const call: SkillKnowledgeCallTiming = { operation, duration_ms: duration, status };
    t.knowledge_calls.push(call);
    t.knowledge_total_ms += duration;
  };
  const wrap = <A extends unknown[], R>(operation: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const started = Date.now();
      try {
        const out = await fn(...args);
        record(operation, started, 'success');
        return out;
      } catch (e) {
        record(operation, started, 'error');
        throw e;
      }
    };
  const wrapped: SkillKnowledgeCapability = {
    // Behaviour-preserving proxy: keep whatever else the capability carries, wrap only I/O.
    ...cap,
    search: wrap('search', (input: Parameters<SkillKnowledgeCapability['search']>[0]) => cap.search(input)),
    resolveSources: wrap('resolveSources', (titles: string[]) => cap.resolveSources(titles)),
    adjacent: wrap('adjacent', (chunkId: string, window?: number) => cap.adjacent(chunkId, window)),
  };
  if (cap.loadByIds) wrapped.loadByIds = wrap('loadByIds', (ids: string[]) => cap.loadByIds!(ids));
  return wrapped;
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
    const t = newTimings();
    const totalStart = Date.now();
    const startedAt = new Date().toISOString();
    if (!validation.ok) {
      const openStart = Date.now();
      await this.openRun(input, runId, skill, startedAt);
      t.persistence_ms += Date.now() - openStart;
      const finalized = await this.finalizeRun(runId, startedAt, 'failed', 'validation', t);
      this.logTurn('failed', skill.id, runId, t, totalStart, { finalized, errorCategory: 'validation' });
      return withDiagnostics(
        failed(skill, runId, 'SKILL_INVALID_INPUT', validation.message),
        t,
        totalStart,
        buildFailureExecution(t, totalStart, 'REQUEST', 'SKILL_INPUT_INVALID', finalized),
      );
    }

    const openStart = Date.now();
    await this.openRun(input, runId, skill, startedAt);
    t.persistence_ms += Date.now() - openStart;
    try {
      const result = await this.executeSkill(input, skill, runId, t, totalStart);
      const finalized = await this.finalizeRun(runId, startedAt, 'completed', undefined, t);
      this.logTurn('completed', skill.id, runId, t, totalStart, { finalized });
      // Observability only: report the measured stages; the Skill's decisions are untouched.
      const execution = buildExecutionTrace({
        t,
        totalStart,
        ...(result.trace?.status ? { traceStatus: result.trace.status } : {}),
        markers: result.trace?.notes ?? [],
        finalized,
        citationRan: (result.trace?.acceptedEvidenceRefs?.length ?? 0) > 0 || result.trace?.sourceSupport === 'SUPPORTED',
      });
      return withDiagnostics(result, t, totalStart, execution);
    } catch (err) {
      // A provider/transport failure is a TECHNICAL failure: it must never be reported as
      // a domain/evidence outcome (e.g. INSUFFICIENT_EVIDENCE means the Skill ran fine).
      const errorCategory: ErrorCategory = err instanceof SkillFailure ? 'validation' : isProviderError(err) ? 'provider' : 'runtime';
      const finalized = await this.finalizeRun(runId, startedAt, 'failed', errorCategory, t);
      const errorCode = (err as { code?: unknown } | null)?.code;
      this.logTurn('failed', skill.id, runId, t, totalStart, {
        finalized,
        errorCategory,
        ...(typeof errorCode === 'string' ? { errorCode: errorCode.slice(0, 64) } : {}),
      });
      // A thrown run has no result, but the runtime still measured the stages: attach them to
      // the error so the tester can show WHERE it failed (adds no field the runtime acts on).
      const timedOut = isTimeoutFailure(err);
      const failureStage: ExecutionStageName = timedOut || isProviderError(err) ? 'MODEL_CALL' : err instanceof SkillFailure ? 'OUTPUT_PARSE' : 'OUTPUT_PARSE';
      const failureCode = timedOut
        ? 'MODEL_TIMEOUT'
        : isProviderError(err)
          ? 'MODEL_PROVIDER_ERROR'
          : err instanceof SkillFailure
            ? 'INVALID_OUTPUT_ENVELOPE'
            : 'UNKNOWN_TECHNICAL_FAILURE';
      try {
        Object.assign(err as Record<string, unknown>, { execution: buildFailureExecution(t, totalStart, failureStage, failureCode, finalized) });
      } catch {
        /* primitive/frozen error — the log line still carries the measurements */
      }
      throw err;
    }
  }

  private async executeSkill(input: SkillExecutionInput, skill: SkillDefinition, runId: string, t: TurnTimings, totalStart: number): Promise<SkillExecutionResult> {
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
      ctx.knowledge = instrumentKnowledge(this.deps.knowledge(input.projectId), t);
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
      // B1.1/K-6: Memory is CONTEXT, not a user assertion — the platform's existing convention is
      // that a memory-derived value carries no certainty, so it must NOT close a material need.
      // Only a value supplied for THIS case (user context) may satisfy a static requirement.
      const known: KnownContextItem[] = [
        ...memory.map((m) => ({ key: m.memoryKey, value: (m.payload as Record<string, unknown>).value, source: 'memory' as const, certainty: 'UNCERTAIN' as const })),
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
        generateText: async ({ workload, parts, message, maxOutputTokens }) => {
          const callIndex = t.model_calls.length + 1;
          const callStart = Date.now();
          try {
            const out = await this.deps.modelGateway!.generateText({
              projectId: input.projectId,
              runId,
              capability: skill.id,
              model: { profile: workload } as ModelGatewayInput['model'],
              input: parts && parts.length > 0 ? { parts } : { message: message ?? '' },
              ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
            });
            const duration = Date.now() - callStart;
            t.model_total_ms += duration;
            if (out.provider) t.provider = String(out.provider).slice(0, 64);
            if (out.model) t.model = String(out.model).slice(0, 96);
            if (out.usage) {
              const u = out.usage;
              if (u.promptTokens !== undefined) t.usage.promptTokens = (t.usage.promptTokens ?? 0) + u.promptTokens;
              if (u.completionTokens !== undefined) t.usage.completionTokens = (t.usage.completionTokens ?? 0) + u.completionTokens;
              if (u.totalTokens !== undefined) t.usage.totalTokens = (t.usage.totalTokens ?? 0) + u.totalTokens;
              if (u.costUsd !== undefined) t.usage.costUsd = (t.usage.costUsd ?? 0) + u.costUsd;
            }
            t.model_calls.push({
              call_index: callIndex,
              duration_ms: duration,
              status: 'success',
              timeout: false,
              ...(out.provider ? { provider: String(out.provider).slice(0, 64) } : {}),
              ...(out.model ? { model: String(out.model).slice(0, 96) } : {}),
              ...(out.usage?.promptTokens !== undefined ? { input_tokens: out.usage.promptTokens } : {}),
              ...(out.usage?.completionTokens !== undefined ? { output_tokens: out.usage.completionTokens } : {}),
              ...(out.usage?.reasoningTokens !== undefined ? { reasoning_tokens: out.usage.reasoningTokens } : {}),
              ...(out.servedBy ? { served_by: String(out.servedBy).slice(0, 48) } : {}),
              ...(out.finishReason ? { finish_reason: String(out.finishReason).slice(0, 32) } : {}),
            });
            return { text: out.text, provider: out.provider, model: out.model, usage: out.usage };
          } catch (e) {
            const duration = Date.now() - callStart;
            const timeout = isTimeoutFailure(e);
            t.model_total_ms += duration;
            t.model_calls.push({ call_index: callIndex, duration_ms: duration, status: timeout ? 'timeout' : 'error', timeout });
            throw e;
          }
        },
      };
      ctx.model = capability;
    }

    t.context_ms = Date.now() - totalStart;
    const skillStart = Date.now();
    const output = await skill.execute(ctx);
    t.skill_ms = Date.now() - skillStart;
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
      ...(lifted.answer ? { answer: lifted.answer } : {}),
      ...(lifted.caseFacts ? { caseFacts: lifted.caseFacts } : {}),
      ...(lifted.skillContext ? { skillContext: lifted.skillContext } : {}),
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

  /**
   * Finalize an opened run into exactly one terminal state. The store write is retried
   * once and its failure is reported (never swallowed): the diagnosed defect was a
   * PostgREST error being ignored, which left runs permanently `started`.
   * Returns whether the terminal state was persisted; it never replaces the caller's error.
   */
  private async finalizeRun(
    runId: string,
    startedAt: string,
    status: 'completed' | 'failed',
    errorCategory: ErrorCategory | undefined,
    t: TurnTimings,
  ): Promise<boolean> {
    const completedAt = new Date().toISOString();
    const patch: Partial<RunRecord> = {
      status,
      completedAt,
      latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      ...(errorCategory ? { errorCategory } : {}),
      ...(t.provider ? { providerKey: t.provider } : {}),
      ...(t.model ? { modelName: t.model } : {}),
      ...(Object.keys(t.usage).length > 0 ? { usage: t.usage } : {}),
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      try {
        await this.deps.persistence.updateRun(runId, patch);
        t.persistence_ms += Date.now() - started;
        return true;
      } catch (e) {
        t.persistence_ms += Date.now() - started;
        if (attempt < 2) continue;
        console.error('[run]', JSON.stringify({
          outcome: 'finalize_failed',
          runId,
          status,
          attempt,
          reason: e instanceof Error ? e.message.slice(0, 160) : 'unknown',
        }));
        return false;
      }
    }
    return false;
  }

  /** One compact, machine-readable line per run (success or failure) so stage timings of a
   *  failed turn are not lost. */
  private logTurn(
    outcome: 'completed' | 'failed',
    skillId: string,
    runId: string,
    t: TurnTimings,
    totalStart: number,
    extra: Record<string, unknown>,
  ): void {
    console.log('[turn]', JSON.stringify({ outcome, skillId, runId, ...snapshotTimings(t, totalStart), ...extra }));
  }
}

/** Attach the runtime-measured timings + execution trace to the result (observability only;
 *  a Skill's own trace fields are preserved, and a trace is created when the Skill had none). */
function withDiagnostics(
  result: SkillExecutionResult,
  t: TurnTimings,
  totalStart: number,
  execution: SkillExecutionTrace,
): SkillExecutionResult {
  return { ...result, trace: { ...(result.trace ?? {}), timings: snapshotTimings(t, totalStart), execution } };
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
const isPrimitiveValue = (v: unknown): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v);

/** Reused bound for a persisted expected-answer contract's allowed-value set. */
const MAX_INTERACTION_OPTIONS = 6;

/**
 * B1.0: a persisted requirement carries its expected-answer contract, bounded and well-formed.
 * A malformed or unknown contract becomes ABSENT — never a permissive fallback (an untrustworthy
 * contract must not be able to authorize a fact).
 */
function liftRequirementInteraction(v: unknown): RequirementInteraction | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (!isInteractionType(o.type)) return undefined;
  const options = Array.isArray(o.options)
    ? o.options
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .slice(0, MAX_INTERACTION_OPTIONS)
        .map((x) => x.trim().slice(0, 80))
    : [];
  return {
    type: o.type,
    ...(options.length ? { options } : {}),
    ...(typeof o.allowOther === 'boolean' ? { allowOther: o.allowOther } : {}),
  };
}

/** B3a: narrow the bounded reusable turn context a skill may hand back. Nothing else passes. */
function liftSkillContext(value: unknown): SkillTurnContext | undefined {
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const skillId = typeof o.skillId === 'string' ? o.skillId.slice(0, 120) : '';
  const skillVersion = typeof o.skillVersion === 'number' ? Math.trunc(o.skillVersion) : 0;
  const issueSignature = typeof o.issueSignature === 'string' ? o.issueSignature.slice(0, 200) : '';
  const baseCaseSignature = typeof o.baseCaseSignature === 'string' ? o.baseCaseSignature.slice(0, 200) : '';
  const at = typeof o.at === 'string' ? o.at.slice(0, 40) : new Date().toISOString();
  const requirements = (Array.isArray(o.requirements) ? o.requirements : [])
    .filter((r) => r && typeof r === 'object' && typeof (r as Record<string, unknown>).key === 'string')
    .slice(0, MAX_SKILL_CONTEXT_REQUIREMENTS)
    .map((r) => {
      const rr = r as Record<string, unknown>;
      const interaction = liftRequirementInteraction(rr.interaction);
      const { interaction: _discard, ...rest } = rr;
      return { ...rest, ...(interaction ? { interaction } : {}) } as unknown as DecisionRequirement;
    });
  const evidenceRefs = (Array.isArray(o.evidenceRefs) ? o.evidenceRefs : []).filter((x) => typeof x === 'string').slice(0, MAX_SKILL_CONTEXT_EVIDENCE) as string[];
  const sourceIds = (Array.isArray(o.sourceIds) ? o.sourceIds : []).filter((x) => typeof x === 'string').slice(0, MAX_SKILL_CONTEXT_SOURCES) as string[];
  if (!skillId || !issueSignature || requirements.length === 0 || evidenceRefs.length === 0) return undefined;
  return { skillId, skillVersion, issueSignature, requirements, evidenceRefs, sourceIds, baseCaseSignature, at };
}

/** Bounded, primitive-only case facts (no nested structures, no prose dumps). */
function liftCaseFacts(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 12)) {
    if (!/^[a-z0-9_]{1,64}$/.test(k)) continue;
    if (isPrimitiveValue(val)) out[k] = typeof val === 'string' ? val.slice(0, 200) : val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function liftFromOutput(output: unknown): { readiness?: ReadinessResult; trace?: SkillTraceSummary; answer?: SkillAnswer; caseFacts?: Record<string, unknown>; skillContext?: SkillTurnContext } {
  const o = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
  const out: { readiness?: ReadinessResult; trace?: SkillTraceSummary; answer?: SkillAnswer; caseFacts?: Record<string, unknown>; skillContext?: SkillTurnContext } = {};

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
              ...(() => {
                const interaction = liftRequirementInteraction(m.interaction);
                return interaction ? { interaction } : {};
              })(),
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
  const tb = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  if (t && typeof t === 'object') {
    const tt = t as Record<string, unknown>;
    const evidence = Array.isArray(tt.evidence)
      ? (tt.evidence as Array<Record<string, unknown>>)
          .filter((e) => e && typeof e === 'object' && typeof e.chunkId === 'string' && typeof e.sourceId === 'string')
          .slice(0, 12)
          .map((e) => ({ chunkId: String(e.chunkId).slice(0, 64), sourceId: String(e.sourceId).slice(0, 64), ...(str(e.note, 120) ? { note: str(e.note, 120)! } : {}) }))
      : undefined;
    const trace: SkillTraceSummary = {
    ...(typeof tb.plannerCalled === 'boolean' ? { plannerCalled: tb.plannerCalled as boolean } : {}),
    ...(typeof tb.retrievalCalled === 'boolean' ? { retrievalCalled: tb.retrievalCalled as boolean } : {}),
    ...(typeof tb.interpreterCalled === 'boolean' ? { interpreterCalled: tb.interpreterCalled as boolean } : {}),
    ...(typeof tb.decisionCalled === 'boolean' ? { decisionCalled: tb.decisionCalled as boolean } : {}),
    ...(typeof tb.evidenceReloadCalled === 'boolean' ? { evidenceReloadCalled: tb.evidenceReloadCalled as boolean } : {}),
      ...(str(tt.issue, 300) ? { issue: str(tt.issue, 300)! } : {}),
      ...(str(tt.status, 60) ? { status: str(tt.status, 60)! } : {}),
      ...(strList(tt.approvedSourceIds, 10, 64) ? { approvedSourceIds: strList(tt.approvedSourceIds, 10, 64)! } : {}),
      ...(evidence && evidence.length ? { evidence } : {}),
      ...(strList(tt.requirementKeys, 12, 64) ? { requirementKeys: strList(tt.requirementKeys, 12, 64)! } : {}),
      ...(strList(tt.notes, 6, 200) ? { notes: strList(tt.notes, 6, 200)! } : {}),
      ...(str(tt.decisionStatus, 60) ? { decisionStatus: str(tt.decisionStatus, 60)! } : {}),
      ...(str(tt.decisionLabel, 120) ? { decisionLabel: str(tt.decisionLabel, 120)! } : {}),
      ...(str(tt.confidence, 16) ? { confidence: str(tt.confidence, 16)! } : {}),
      ...(str(tt.sourceSupport, 32) ? { sourceSupport: str(tt.sourceSupport, 32)! } : {}),
      ...(strList(tt.retrievedEvidenceIds, 12, 64) ? { retrievedEvidenceIds: strList(tt.retrievedEvidenceIds, 12, 64)! } : {}),
      ...(strList(tt.acceptedEvidenceRefs, 8, 64) ? { acceptedEvidenceRefs: strList(tt.acceptedEvidenceRefs, 8, 64)! } : {}),
      ...(strList(tt.gapKeys, 8, 200) ? { gapKeys: strList(tt.gapKeys, 8, 200)! } : {}),
      ...(str(tt.workload, 64) ? { workload: str(tt.workload, 64)! } : {}),
      ...(str(tt.model, 96) ? { model: str(tt.model, 96)! } : {}),
    };
    if (Object.keys(trace).length > 0) out.trace = trace;
  }

  const a = o.answer;
  if (a && typeof a === 'object') {
    const aa = a as Record<string, unknown>;
    const text = str(aa.text, 1200);
    if (text) {
      const evidenceIds = strList(aa.evidenceIds, 6, 64);
      out.answer = {
        text,
        ...(str(aa.sourceTitle, 160) ? { sourceTitle: str(aa.sourceTitle, 160)! } : {}),
        ...(evidenceIds ? { evidenceIds } : {}),
        ...(str(aa.label, 80) ? { label: str(aa.label, 80)! } : {}),
      };
    }
  }

  const caseFacts = liftCaseFacts(o.caseFacts);
  if (caseFacts) out.caseFacts = caseFacts;
  const skillContext = liftSkillContext(o.skillContext);
  if (skillContext) out.skillContext = skillContext;

  return out;
}
