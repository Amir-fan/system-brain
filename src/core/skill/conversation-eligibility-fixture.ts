/**
 * @kip
 * @module skill
 * @layer core
 * @owner platform-core
 * @feature K23
 * @purpose Neutral proof fixture for the conversation layer. Domain: a generic
 *          "eligibility review" (NO Naqaa/fiqh concepts). Declares material
 *          requirements with structured-interaction hints; its body runs only when
 *          Decision Readiness is READY_FOR_DECISION.
 */

import type { SkillDefinition, SkillExecutionContext } from './skill.ts';

export const conversationEligibilityFixture: SkillDefinition = {
  id: 'demo.conversation-eligibility',
  version: 1,
  description: 'Neutral proof: multi-turn eligibility review gated by Decision Readiness.',
  requirements: { understanding: false, memory: false, knowledge: false, model: false },

  readiness: {
    requirements: [
      {
        key: 'event_date',
        description: 'The date the event started.',
        material: true,
        question: { key: 'event_date', wording: 'في أي تاريخ بدأ الحدث؟' },
        interaction: { type: 'date' },
      },
      {
        key: 'duration_days',
        description: 'How many days the event lasted.',
        material: true,
        question: { key: 'duration_days', wording: 'كم يوماً استمر هذا الحدث؟' },
        interaction: { type: 'duration' },
      },
      {
        key: 'eligibility_status',
        description: 'Optional prior eligibility outcome.',
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
    const facts = (ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>).context : {}) as Record<string, unknown>;
    return { decisionAllowed: true, readiness: ctx.readiness?.status, reviewed: Object.keys(facts).sort() };
  },
};
