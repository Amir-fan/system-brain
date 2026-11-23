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
  /**
   * Trusted capability instructions, kept separate from untrusted user/retrieved
   * content. Provider adapters map this to their highest supported instruction role.
   */
  instructions?: string;
  input: unknown;
  /**
   * Optional bounded OUTPUT budget. Provider-neutral by design: the caller states
   * how much output it needs, the provider adapter maps it to its own parameter
   * (e.g. OpenRouter `max_tokens`). Omitted => the provider's own default, exactly
   * as before. No workload or provider policy is expressed here.
   */
  maxOutputTokens?: number;
  /** Workload intent only — never a hardcoded provider model id. */
  model?: ModelRequirement;
  /** Optional already-resolved model id (from the control-plane assignment resolver). */
  modelId?: string;
  /**
   * Optional provider-neutral structured-output request: the caller declares the exact
   * response shape it needs (a JSON Schema). The provider adapter maps it to its own
   * mechanism (e.g. OpenRouter/OpenAI `response_format: {type:'json_schema'}`). Omitted =>
   * the request carries no structured-output requirement, exactly as before. The gateway
   * knows nothing about the schema's meaning; it is execution plumbing only.
   */
  responseFormat?: { name: string; strict?: boolean; schema: Record<string, unknown> };
  /**
   * Workload/Skill-scoped reasoning hint. Provider-neutral vocabulary: 'low' | 'medium'
   * | 'high' | 'off'. The adapter maps it to its own mechanism (OpenRouter `reasoning.effort`).
   * Provider defaults are used when omitted. Distinct from the gateway-global K29 env knob:
   * one workload can request 'low' while another stays default.
   */
  reasoning?: 'low' | 'medium' | 'high' | 'off';
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Hidden reasoning tokens, when the provider reports them separately. */
  reasoningTokens?: number;
}

export interface ModelGatewayOutput {
  text: string;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
  latencyMs?: number;
  /** The provider backend that actually served the call, when the provider reports it. */
  servedBy?: string;
  /** Why generation stopped (e.g. stop / length), when the provider reports it. */
  finishReason?: string;
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

/**
 * K21 multimodal content part — the smallest project-agnostic shape a caller can
 * pass as `ModelGatewayInput.input.parts` for a vision-capable model. Provider-
 * specific conversion (e.g. OpenRouter/OpenAI `image_url`) lives ONLY in the
 * provider adapter. `image` is carried as a data URL (no public bucket, no raw
 * media persistence; never stored in Memory).
 */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string };

/** Convenience input shape accepted by the OpenRouter adapter for multimodal calls. */
export interface MultimodalInput {
  parts: ModelContentPart[];
}

/** Trace metadata a capability may attach to a completed run (provider-neutral). */
export type RunModelMetadata = {
  provider?: string;
  model?: string;
  usage?: ModelUsage;
};

export const RUN_MODEL_METADATA = Symbol.for('kip.runModelMetadata');
