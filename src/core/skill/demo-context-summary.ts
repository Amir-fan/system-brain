/**
 * @kip
 * @module skill
 * @layer core
 * @owner intelligence-knowledge
 * @feature K20
 * @purpose Neutral proof Skill: demo.context-summary (version 1).
 *
 * Proves the runtime can resolve a Skill, validate input, receive Structured
 * Understanding (K19) and bounded Memory (K18), produce structured output, and run
 * WITHOUT any LLM or Knowledge. NOT a production feature.
 */

import type { SkillDefinition, SkillExecutionContext } from './skill.ts';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const demoContextSummary: SkillDefinition = {
  id: 'demo.context-summary',
  version: 1,
  description: 'Summarize what the runtime understood and the bounded relevant context.',
  requirements: { understanding: true, memory: true, knowledge: false, model: false },

  validateInput(input: unknown) {
    if (!isObj(input)) return { ok: false, message: 'input must be an object' };
    if (typeof input.text !== 'string' || input.text.trim().length === 0) {
      return { ok: false, message: 'text (string) is required' };
    }
    return { ok: true };
  },

  validateOutput(output: unknown) {
    if (!isObj(output)) return { ok: false, message: 'output must be an object' };
    if (!Array.isArray(output.understoodIssues)) return { ok: false, message: 'understoodIssues must be an array' };
    if (!Array.isArray(output.relevantContext)) return { ok: false, message: 'relevantContext must be an array' };
    return { ok: true };
  },

  async execute(ctx: SkillExecutionContext) {
    const understoodIssues = ctx.understanding?.issues ?? [];
    const relevantContext = (ctx.memory ?? []).map((m) => ({ key: m.memoryKey, value: (m.payload as Record<string, unknown>).value ?? null }));
    return { understoodIssues, relevantContext };
  },
};
