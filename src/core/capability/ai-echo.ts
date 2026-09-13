/**
 * @kip
 * @module capability
 * @layer core
 * @owner platform-core
 * @feature K0-006
 * @purpose AI platform test capability that declares an explicit workload.
 *
 * Provider-neutral: the caller states a canonical workload (e.g. source_analysis)
 * via input.workload; the control-plane ModelAssignmentResolver maps it to a model.
 * Never contains a raw provider model id. No silent default-model fallback.
 */

import type { CapabilityInput, CapabilityResult } from './capability.ts';
import type { ModelGateway } from '../model-gateway/model-gateway.ts';
import type { ModelRequirement } from '../model-gateway/model-gateway.ts';

export interface AiCompletionsInput {
  message?: string;
  /** Canonical workload to resolve through ModelAssignment (default: source_analysis). */
  workload?: 'source_analysis' | 'chat_assistant' | 'vision_scan' | 'summarization' | 'embeddings' | string;
}

/** Trivial AI completion used to prove workload -> assigned model -> gateway path. */
export const platformAiCompletion = (gateway: ModelGateway) => {
  return async (input: CapabilityInput): Promise<CapabilityResult> => {
    const req = (input.input ?? {}) as AiCompletionsInput;
    const workload = req.workload ?? 'source_analysis';
    const requirement: ModelRequirement = { profile: workload };

    const out = await gateway.generateText({
      projectId: input.projectId,
      runId: '',
      capability: input.capability,
      input: { message: String(req.message ?? '') },
      model: requirement,
    });
    return {
      value: { text: out.text },
      model: { provider: out.provider, model: out.model, usage: out.usage },
    };
  };
};

/** Backward-compatible alias for existing tests/usage. */
export const platformAiEcho = platformAiCompletion;