/**
 * @kip
 * @module skill
 * @layer core
 * @owner platform-core
 * @feature K22
 * @purpose Neutral proof fixture for the Decision Readiness gate. It declares material
 *          requirements and a trivial body — purely to prove the gate blocks/permits
 *          execution. NEUTRAL: contains NO domain/fiqh concepts.
 *
 * Its body only runs when readiness === READY_FOR_DECISION.
 */

import type { SkillDefinition, SkillExecutionContext } from './skill.ts';

export const decisionReadinessFixture: SkillDefinition = {
  id: 'demo.decision-readiness',
  version: 1,
  description: 'Neutral proof: a decision-capable skill gated by Decision Readiness.',
  requirements: { understanding: false, memory: true, knowledge: false, model: false },

  // Domain-declared material requirements — the gate stays generic.
  readiness: {
    requirements: [
      {
        key: 'prior_complete_days',
        description: 'How many complete days passed immediately before the event.',
        material: true,
        question: { key: 'prior_complete_days', wording: 'كم يوماً كاملاً مرّ قبل بدء هذا الحدث؟' },
      },
      {
        key: 'optional_note',
        description: 'An optional free note (never blocks).',
        material: false,
      },
    ],
  },

  validateInput(input: unknown) {
    return input && typeof input === 'object' ? { ok: true } : { ok: false, message: 'input must be an object' };
  },
  validateOutput(output: unknown) {
    const o = output as Record<string, unknown> | null;
    return o && typeof o === 'object' && typeof (o as Record<string, unknown>).decisionAllowed === 'boolean'
      ? { ok: true }
      : { ok: false, message: 'decisionAllowed required' };
  },

  async execute(ctx: SkillExecutionContext) {
    return {
      decisionAllowed: true,
      readiness: ctx.readiness?.status,
      inputs: { prior_complete_days: ctx.readiness?.satisfied.includes('prior_complete_days') ?? false },
    };
  },
};
