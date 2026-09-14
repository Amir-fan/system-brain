/**
 * @kip
 * @module model-gateway
 * @layer core
 * @owner platform-core
 * @feature K0-004
 * @purpose Provider-neutral Model Gateway input/output/usage contracts.
 *
 * One Gateway. Many future workloads. Potentially many models/providers.
 * Callers express workload via provider-neutral ModelRequirement; the Gateway
 * (and eventually a Model Policy) resolves the actual model at the boundary.
 * No provider SDK or provider-specific type ever crosses into Core.
 */

export interface ModelRequirement {
  /** Workload profile, e.g. `fast`, `balanced`, `source-analysis` (future). */
  profile?: string;
  /** Coarse provider-neutral capabilities a future selector may use. */
  reasoning?: 'low' | 'balanced' | 'high';
  vision?: boolean;
  latency?: 'fast' | 'balanced';
}

export interface ModelGatewayInput {
  projectId: string;
  runId: string;
  capability: string;
  input: unknown;
  /** Workload intent only — never a hardcoded provider model id. */
  model?: ModelRequirement;
  /** Optional already-resolved model id (from the control-plane assignment resolver). */
  modelId?: string;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ModelGatewayOutput {
  text: string;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
  latencyMs?: number;
}

/**
 * Embedding input. Deliberately SEPARATE from text generation: an embedding call
 * has its own provider endpoint, its own failure modes (rate limits, dimension
 * drift) and its own accounting, so it never rides on generateText().
 *
 * `inputType` is provider-neutral intent: knowledge being indexed is a document,
 * a future retrieval query is a query. No provider-specific type crosses here.
 */
export interface EmbedTextsInput {
  projectId: string;
  runId: string;
  texts: string[];
  inputType?: 'document' | 'query';
  /** Requested output width. The provider may honour it (MRL) or not. */
  dimensions?: number;
  model?: ModelRequirement;
  /** Already-resolved model id (from the control-plane assignment resolver). */
  modelId?: string;
}

export interface EmbedTextsOutput {
  /** One vector per input text, in the same order. */
  vectors: number[][];
  provider?: string;
  model?: string;
  dimensions?: number;
  usage?: ModelUsage;
  latencyMs?: number;
}

/**
 * The single provider-neutral door to external models.
 * Implemented by a platform provider adapter; consumed by Core capabilities.
 */
export interface ModelGateway {
  generateText(input: ModelGatewayInput): Promise<ModelGatewayOutput>;
  embedTexts(input: EmbedTextsInput): Promise<EmbedTextsOutput>;
}

/** Trace metadata a capability may attach to a completed run (provider-neutral). */
export type RunModelMetadata = {
  provider?: string;
  model?: string;
  usage?: ModelUsage;
};

export const RUN_MODEL_METADATA = Symbol.for('kip.runModelMetadata');