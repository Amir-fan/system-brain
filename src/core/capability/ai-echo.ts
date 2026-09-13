/**
 * @kip
 * @module capability
 * @layer core
 * @owner platform-core
 * @feature K0-004
 * @purpose AI-backed platform test capability: proves Capability -> Model Gateway -> provider.
 */

import type { CapabilityInput, CapabilityResult } from './capability.ts';
import type { ModelGateway } from '../model-gateway/model-gateway.ts';

export interface AiEchoInput {
  message?: string;
}

/**
 * Internal, provider-agnostic capability used only to validate the runtime
 * spine + Model Gateway path. Not a product feature. Caller declares a cheap
 * workload via ModelRequirement; the gateway resolves the model.
 */
export const platformAiEcho = (gateway: ModelGateway) => {
  return async (input: CapabilityInput): Promise<CapabilityResult> => {
    const req = (input.input ?? {}) as AiEchoInput;
    const text = String(req.message ?? '');
    const out = await gateway.generateText({
      projectId: input.projectId,
      runId: '',
      capability: input.capability,
      input: { message: text },
      model: { profile: 'fast', latency: 'fast', reasoning: 'low' },
    });
    return {
      value: { text: out.text },
      model: { provider: out.provider, model: out.model, usage: out.usage },
    };
  };
};