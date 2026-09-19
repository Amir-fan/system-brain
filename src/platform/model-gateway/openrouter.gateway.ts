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
import { isProviderError, providerError } from '../../core/model-gateway/gateway-errors.ts';
import type { ProviderError } from '../../core/runtime/runtime.ts';
import {
  EMBEDDING_MAX_RETRIES,
  EMBEDDING_RETRY_BACKOFF_MS,
  EMBEDDING_RETRYABLE_STATUS,
} from '../../core/embedding/embedding.ts';
import type { EmbedTextsInput, EmbedTextsOutput } from '../../core/model-gateway/model-gateway.ts';

const BASE = 'https://openrouter.ai/api/v1';
/** Bounded per-request timeout; embeddings of one bounded batch finish well inside it. */
const EMBEDDING_TIMEOUT_MS = 60_000;
/**
 * Bound for ONE chat/model call. Without it a hung provider call could keep a run open
 * indefinitely (observed: >300 s, and a run left permanently `started`).
 * 300_000 (5 min) is deliberately above the slowest observed SUCCESSFUL call (285 s) so
 * no legitimately slow call is cut, and far below "indefinite" so a stall becomes a
 * classified technical failure instead of an untracked hang.
 * Override with KIP_CHAT_TIMEOUT_MS (milliseconds).
 */
const CHAT_TIMEOUT_MS = 300_000;

/**
 * K29 — operator-level chat request tuning. Both settings are OFF unless the environment
 * sets them, so the default request body stays exactly what it was. They only influence
 * (a) which provider backend serves the call and (b) how much hidden reasoning the provider
 * allows: they never change how a Skill reasons, and they use documented OpenRouter request
 * fields only. Invalid values are ignored rather than forwarded.
 */
const PROVIDER_SORTS = ['throughput', 'latency', 'price'] as const;
const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;

function resolveProviderSort(raw: string): string | undefined {
  const v = raw.trim();
  return (PROVIDER_SORTS as readonly string[]).includes(v) ? v : undefined;
}

function resolveReasoningEffort(raw: string): string | undefined {
  const v = raw.trim();
  return (REASONING_EFFORTS as readonly string[]).includes(v) ? v : undefined;
}

/** Per-call resolution: a Skill that passes `reasoning` overrides the gateway-global default
 *  for this call only. Returns undefined when both are unset or the request is 'off'. */
const PER_CALL_REASONING = ['low', 'medium', 'high', 'off'] as const;
type PerCallReasoning = (typeof PER_CALL_REASONING)[number];
function resolvePerCallReasoning(raw: string | undefined): PerCallReasoning | undefined {
  if (raw === undefined) return undefined;
  const v = String(raw).trim().toLowerCase();
  return (PER_CALL_REASONING as readonly string[]).includes(v) ? (v as PerCallReasoning) : undefined;
}

function resolveChatTimeoutMs(): number {
  const raw = Number(process.env.KIP_CHAT_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : CHAT_TIMEOUT_MS;
}

/**
 * Normalize a provider failure — whether it surfaces while opening the request OR while
 * reading the response body (a stall after headers used to escape unclassified and reach
 * callers as a bare DOMException, losing the lowercase `provider` kind). Never leaks
 * provider internals upward: only the canonical kind + a machine code survive.
 */
function classifyChatFailure(e: unknown, timeoutMs: number): ProviderError {
  if (isProviderError(e)) return e;
  const name = (e as { name?: unknown } | null)?.name;
  const code = (e as { code?: unknown } | null)?.code;
  const timedOut =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    code === 'PROVIDER_CHAT_TIMEOUT' ||
    (typeof code === 'string' && code.startsWith('UND_ERR_') && code.includes('TIMEOUT'));
  return timedOut
    ? providerError('chat completion timed out', 'PROVIDER_CHAT_TIMEOUT', { timeoutMs })
    : providerError('chat completion transport failure', 'PROVIDER_CHAT_FAILED', { reason: 'transport' });
}

export interface OpenRouterAdapterOptions {
  apiKey: string;
  defaultModel: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  /** Inject for tests; defaults to KIP_CHAT_TIMEOUT_MS or CHAT_TIMEOUT_MS. */
  chatTimeoutMs?: number;
  /** Inject for tests; defaults to KIP_PROVIDER_SORT (unset = the request carries no routing preference). */
  providerSort?: string;
  /** Inject for tests; defaults to KIP_REASONING_EFFORT (unset = the request carries no reasoning setting). */
  reasoningEffort?: string;
}

export interface OpenRouterModelSummary {
  id: string;
  name?: string;
}

export class OpenRouterGateway implements ModelGateway {
  private readonly fetcher: typeof fetch;
  private readonly defaultModel: string;
  private readonly chatTimeoutMs: number;
  private readonly providerSort: string | undefined;
  private readonly reasoningEffort: string | undefined;

  constructor(private readonly opts: OpenRouterAdapterOptions) {
    this.fetcher = opts.fetchImpl ?? fetch;
    this.defaultModel = opts.defaultModel;
    this.chatTimeoutMs = opts.chatTimeoutMs ?? resolveChatTimeoutMs();
    // One validation point for both sources: an invalid value is dropped, never forwarded.
    // Tests may pass an explicit `''` to disable an env default without mutating the env.
    this.providerSort = resolveProviderSort(opts.providerSort !== undefined ? opts.providerSort : (process.env.KIP_PROVIDER_SORT ?? ''));
    this.reasoningEffort = resolveReasoningEffort(opts.reasoningEffort !== undefined ? opts.reasoningEffort : (process.env.KIP_REASONING_EFFORT ?? ''));
  }

  /** Combined per-call resolution: caller > env default; 'off' means suppress. */
  private resolveReasoningForCall(caller: unknown, envDefault: string | undefined): string | undefined {
    const perCall = resolvePerCallReasoning(typeof caller === 'string' ? caller : undefined);
    if (perCall === 'off') return undefined;
    if (perCall !== undefined) return perCall;
    return envDefault;
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

    // The caller's bounded output budget, when it asked for one. This adapter maps
    // it verbatim and never decides how much output a workload deserves.
    const maxOutputTokens =
      typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens) && input.maxOutputTokens > 0
        ? Math.trunc(input.maxOutputTokens)
        : undefined;

    let res: Response;
    try {
      res = await this.raw('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
          // K29 operator settings: absent unless configured, so the default body is unchanged.
          ...(this.providerSort ? { provider: { sort: this.providerSort } } : {}),
          // K29-RADICAL: per-call reasoning overrides the gateway-global default for one
          // workload/Skill without affecting the rest of the platform.
          ...(this.resolveReasoningForCall(input.reasoning, this.reasoningEffort) ? { reasoning: { effort: this.resolveReasoningForCall(input.reasoning, this.reasoningEffort)! } } : {}),
          // P0.4 opt-in structured output: present only when the caller asked for a schema.
          ...(input.responseFormat
            ? { response_format: { type: 'json_schema', json_schema: { name: input.responseFormat.name, strict: input.responseFormat.strict ?? true, schema: input.responseFormat.schema } } }
            : {}),
        }),
        signal: AbortSignal.timeout(this.chatTimeoutMs),
      });
    } catch (e) {
      // Socket/DNS/transport failure or timeout: normalized at the platform boundary so
      // callers keep a technical failure distinct from a reasoning/evidence outcome.
      throw classifyChatFailure(e, this.chatTimeoutMs);
    }

    if (!res.ok) {
      throw providerError('chat completion failed', 'PROVIDER_CHAT_FAILED', { status: res.status });
    }

    let body: {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      model?: string;
      /** OpenRouter reports the backend that actually served the call. */
      provider?: string;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      // A stall/abort AFTER the headers arrived must be classified exactly like one before.
      throw classifyChatFailure(e, this.chatTimeoutMs);
    }
    const text = body.choices?.[0]?.message?.content ?? '';
    // Observability only: which backend served the call, why it stopped, and how much of the
    // completion was hidden reasoning. Reported raw when the provider sends it, otherwise absent.
    const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens;
    const finishReason = body.choices?.[0]?.finish_reason;
    return {
      text,
      provider: 'openrouter',
      model: body.model ?? model,
      usage: {
        promptTokens: body.usage?.prompt_tokens,
        completionTokens: body.usage?.completion_tokens,
        totalTokens: body.usage?.total_tokens,
        ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
      },
      ...(typeof body.provider === 'string' && body.provider.length > 0 ? { servedBy: body.provider } : {}),
      ...(typeof finishReason === 'string' && finishReason.length > 0 ? { finishReason } : {}),
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