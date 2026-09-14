/**
 * @kip
 * @module model-gateway
 * @layer platform
 * @owner platform-api
 * @feature K0-006
 * @purpose Control-plane Model Gateway decorator: resolves a workload to a model
 * before the provider adapter runs, leaving the adapter assignment-blind.
 *
 * Split:
 *   Capability -> ModelRequirement/workload
 *   -> ModelAssignmentResolver (this layer) -> { providerKey, modelId }
 *   -> ModelGateway generateText -> OpenRouterGateway (thin, uses resolved modelId)
 *
 * The provider adapter never knows assignments, workload persistence, or policy.
 */

import type {
  EmbedTextsInput,
  EmbedTextsOutput,
  ModelGateway,
  ModelGatewayInput,
  ModelGatewayOutput,
} from '../../core/model-gateway/model-gateway.ts';
import type { ModelAssignmentResolver } from '../provider/model-assignment.ts';

export class ResolvingModelGateway implements ModelGateway {
  constructor(
    private readonly inner: ModelGateway,
    private readonly resolver: ModelAssignmentResolver,
  ) {}

  async generateText(input: ModelGatewayInput): Promise<ModelGatewayOutput> {
    // If an explicit resolved model id was already supplied (e.g. tests), use it.
    let modelId = input.modelId;
    if (!modelId) {
      const resolved = await this.resolver.resolve(input.model ?? {});
      modelId = resolved.modelId;
    }
    return this.inner.generateText({ ...input, modelId });
  }

  /**
   * Same control-plane resolution for embeddings: the canonical `embeddings`
   * workload maps to a model, and a missing assignment fails explicitly here.
   * The adapter stays assignment-blind and never picks a model on its own.
   */
  async embedTexts(input: EmbedTextsInput): Promise<EmbedTextsOutput> {
    let modelId = input.modelId;
    if (!modelId) {
      const resolved = await this.resolver.resolve(input.model ?? { profile: 'embeddings' });
      modelId = resolved.modelId;
    }
    return this.inner.embedTexts({ ...input, modelId });
  }
}