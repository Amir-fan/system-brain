/**
 * @kip
 * @module model-gateway
 * @layer platform
 * @owner platform-infra
 * @feature K0-004
 * @purpose OpenAI provider adapter for the Core Model Gateway.
 */

import OpenAI from 'openai';
import type {
  ModelGateway,
  ModelGatewayInput,
  ModelGatewayOutput,
} from '../../core/model-gateway/model-gateway.ts';
import { providerError } from '../../core/model-gateway/gateway-errors.ts';

export interface OpenAiGatewayOptions {
  apiKey: string;
  model: string;
}

/**
 * Single concrete provider adapter. This is the ONLY file that imports a
 * provider SDK. Capabilities, Core, and API never see OpenAI types.
 */
export class OpenAiGateway implements ModelGateway {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAiGatewayOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async generateText(input: ModelGatewayInput): Promise<ModelGatewayOutput> {
    const started = Date.now();
    try {
      const text = await this.promptText(input);
      return { text, provider: 'openai', model: this.model, latencyMs: Date.now() - started };
    } catch (err) {
      throw providerError('model provider call failed', 'PROVIDER_CALL_FAILED', {
        kind: err instanceof OpenAI.APIError ? err.status : undefined,
      });
    }
  }

  private async promptText(input: ModelGatewayInput): Promise<string> {
    const message = String((input.input as { message?: unknown } | undefined)?.message ?? '');
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: message }],
    });
    const content = stream.choices[0]?.message?.content ?? '';
    return content;
  }
}