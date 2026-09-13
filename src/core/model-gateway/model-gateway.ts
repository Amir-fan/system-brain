/**
 * @kip
 * @module model-gateway
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Provider-neutral Model Gateway input/output/usage contracts.
 */

export interface ModelGatewayInput {
  projectId: string;
  runId: string;
  capability: string;
  input: unknown;
  modelPreference?: string;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ModelGatewayOutput {
  output: unknown;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
}