/**
 * @kip
 * @module model-gateway
 * @layer platform
 * @owner platform-infra
 * @feature K0-005
 * @purpose OpenRouter provider adapter for the Core Model Gateway (plain HTTP).
 *
 * The single provider adapter for this slice. No SDK, no direct OpenAI path.
 * All external model calls happen only through the KIP Model Gateway.
 */

import type {
  ModelGateway,
  ModelGatewayInput,
  ModelGatewayOutput,
} from '../../core/model-gateway/model-gateway.ts';
import { providerError } from '../../core/model-gateway/gateway-errors.ts';

const BASE = 'https://openrouter.ai/api/v1';

export interface OpenRouterAdapterOptions {
  apiKey: string;
  defaultModel: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
}

export interface OpenRouterModelSummary {
  id: string;
  name?: string;
}

export class OpenRouterGateway implements ModelGateway {
  private readonly fetcher: typeof fetch;
  private readonly defaultModel: string;

  constructor(private readonly opts: OpenRouterAdapterOptions) {
    this.fetcher = opts.fetchImpl ?? fetch;
    this.defaultModel = opts.defaultModel;
  }

  /** Runtime credential set (from Vault). Never logged. */
  setApiKey(key: string): void {
    this.opts.apiKey = key;
  }

  private async raw(path: string, init?: RequestInit): Promise<Response> {
    return this.fetcher(`${BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
        ...(init?.headers ?? {}),
      },
    });
  }

  /** Zero-cost credential validation: GET /api/v1/auth/key. Throws on invalid. */
  async validateKey(): Promise<boolean> {
    const res = await this.raw('/auth/key');
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) throw providerError('provider validation failed', 'PROVIDER_VALIDATION_FAILED');
    return true;
  }

  /** Public model catalog (counts as "available models"). */
  async listModels(): Promise<OpenRouterModelSummary[]> {
    const res = await this.raw('/models');
    if (!res.ok) throw providerError('models request failed', 'PROVIDER_MODELS_FAILED');
    const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.name }));
  }

  async generateText(input: ModelGatewayInput): Promise<ModelGatewayOutput> {
    const started = Date.now();
    const message = String((input.input as { message?: unknown } | undefined)?.message ?? '');
    const model = this.defaultModel;

    const res = await this.raw('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!res.ok) {
      throw providerError('chat completion failed', 'PROVIDER_CHAT_FAILED', { status: res.status });
    }

    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };
    const text = body.choices?.[0]?.message?.content ?? '';
    return {
      text,
      provider: 'openrouter',
      model: body.model ?? model,
      usage: {
        promptTokens: body.usage?.prompt_tokens,
        completionTokens: body.usage?.completion_tokens,
        totalTokens: body.usage?.total_tokens,
      },
      latencyMs: Date.now() - started,
    };
  }
}