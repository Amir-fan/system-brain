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
import {
  EMBEDDING_MAX_RETRIES,
  EMBEDDING_RETRY_BACKOFF_MS,
  EMBEDDING_RETRYABLE_STATUS,
} from '../../core/embedding/embedding.ts';
import type { EmbedTextsInput, EmbedTextsOutput } from '../../core/model-gateway/model-gateway.ts';

const BASE = 'https://openrouter.ai/api/v1';
/** Bounded per-request timeout; embeddings of one bounded batch finish well inside it. */
const EMBEDDING_TIMEOUT_MS = 60_000;

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
    // The control-plane resolver supplies the model id. If none was resolved,
    // fall back to this adapter's configured default model (the boot default).
    const model = input.modelId ?? this.defaultModel;

    // K21 multimodal: when the caller passes `input.parts` (text + image content
    // parts), build an OpenAI/OpenRouter content array. Provider-specific
    // conversion lives here, never in a Skill or the Core gateway.
    const raw = (input.input ?? {}) as Record<string, unknown>;
    const parts = raw.parts as Array<{ type: string; text?: string; dataUrl?: string }> | undefined;
    const content: unknown =
      Array.isArray(parts) && parts.length > 0
        ? parts.map((p) =>
            p.type === 'image'
              ? { type: 'image_url', image_url: { url: p.dataUrl } }
              : { type: 'text', text: p.text ?? '' },
          )
        : String((input.input as { message?: unknown } | undefined)?.message ?? '');

    const res = await this.raw('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
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

  /**
   * Embeddings via OpenRouter's OpenAI-compatible /embeddings route.
   *
   * Retries ONLY transient failures (429/500/502/503/524/529 and network
   * timeouts) with bounded backoff; terminal provider answers (400/401/402/403/
   * 404/413) fail immediately. Never logs input text, vectors or the credential.
   */
  async embedTexts(input: EmbedTextsInput): Promise<EmbedTextsOutput> {
    const started = Date.now();
    const model = input.modelId ?? this.defaultModel;

    const body: Record<string, unknown> = {
      model,
      input: input.texts,
      encoding_format: 'float',
    };
    // Only sent when the caller pinned a width; the service always does.
    if (input.dimensions !== undefined) body.dimensions = input.dimensions;
    if (input.inputType) {
      body.input_type = input.inputType === 'query' ? 'search_query' : 'search_document';
    }

    let lastStatus = 0;
    for (let attempt = 0; attempt <= EMBEDDING_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const wait = EMBEDDING_RETRY_BACKOFF_MS[
          Math.min(attempt - 1, EMBEDDING_RETRY_BACKOFF_MS.length - 1)
        ];
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      let res: Response;
      try {
        res = await this.raw('/embeddings', {
          method: 'POST',
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
        });
      } catch {
        lastStatus = 0; // network failure / timeout: retryable, never a terminal answer
        continue;
      }

      if (!res.ok) {
        lastStatus = res.status;
        const retryable = (EMBEDDING_RETRYABLE_STATUS as readonly number[]).includes(res.status);
        if (retryable && attempt < EMBEDDING_MAX_RETRIES) continue;
        throw providerError('embedding request failed', 'PROVIDER_EMBEDDING_FAILED', { status: res.status });
      }

      const parsed = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
        model?: string;
        provider?: string;
        usage?: { prompt_tokens?: number; total_tokens?: number; cost?: number };
      };

      // Order is part of the contract: caller's texts[i] must map to vectors[i].
      const vectors = (parsed.data ?? [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => (Array.isArray(d.embedding) ? d.embedding : []));

      return {
        vectors,
        provider: parsed.provider ?? 'openrouter',
        model: parsed.model ?? model,
        dimensions: vectors[0]?.length,
        usage: {
          promptTokens: parsed.usage?.prompt_tokens,
          totalTokens: parsed.usage?.total_tokens,
          costUsd: parsed.usage?.cost,
        },
        latencyMs: Date.now() - started,
      };
    }

    throw providerError('embedding request failed after retries', 'PROVIDER_EMBEDDING_FAILED', {
      status: lastStatus,
    });
  }
}