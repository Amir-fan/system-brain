/**
 * K29 — operator-level provider/reasoning performance configuration (gateway only).
 *
 * Proves: the default request body is unchanged, the supported parameters are sent only when
 * explicitly configured, invalid values are ignored, the serving backend / finish reason /
 * reasoning tokens are reported when the provider sends them, and timeout normalization,
 * tool calling and structured output are untouched. No Skill is involved or modified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';

interface Captured {
  body?: Record<string, unknown>;
}

function fakeFetch(captured: Captured, response: unknown = {}) {
  return (async (url: string, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        model: 'deepseek/deepseek-v4.1-flash',
        ...(response as Record<string, unknown>),
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const call = (gateway: OpenRouterGateway, extra: Record<string, unknown> = {}) =>
  gateway.generateText({
    projectId: 'p',
    runId: 'r',
    capability: 'chat',
    input: { message: 'ما الحكم؟' },
    modelId: 'deepseek/deepseek-v4.1-flash',
    maxOutputTokens: 16384,
    ...extra,
  } as never);

test('K29/A: with nothing configured the request body carries no routing or reasoning field', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), providerSort: '', reasoningEffort: '' });
  await call(gw);
  assert.deepEqual(Object.keys(captured.body!).sort(), ['max_tokens', 'messages', 'model']);
  assert.equal(captured.body!.provider, undefined);
  assert.equal(captured.body!.reasoning, undefined);
  assert.equal(captured.body!.response_format, undefined);
});

test('K29/B: a configured provider sort is sent as provider.sort (documented field)', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), providerSort: 'throughput' });
  await call(gw);
  assert.deepEqual(captured.body!.provider, { sort: 'throughput' });
});

test('K29/C: an unsupported value is ignored, never forwarded', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), providerSort: 'turbo', reasoningEffort: 'extreme' });
  await call(gw);
  assert.equal(captured.body!.provider, undefined);
  assert.equal(captured.body!.reasoning, undefined);
});

test('K29/D: a configured reasoning effort is sent as reasoning.effort (documented field)', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), reasoningEffort: 'low' });
  await call(gw);
  assert.deepEqual(captured.body!.reasoning, { effort: 'low' });
});

test('K29/E: the serving backend, finish reason and reasoning tokens are reported when sent', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({
    apiKey: 'test-key',
    defaultModel: 'm',
    fetchImpl: fakeFetch(captured, {
      provider: 'Together',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 15 } },
    }),
  });
  const out = await call(gw);
  assert.equal(out.servedBy, 'Together');
  assert.equal(out.finishReason, 'stop');
  assert.equal(out.usage?.reasoningTokens, 15);
  assert.equal(out.provider, 'openrouter');
});

test('K29/F: nothing is reported when the provider sends nothing (no invented values)', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured) });
  const out = await call(gw);
  assert.equal(out.servedBy, undefined);
  assert.equal(out.finishReason, undefined);
  assert.equal(out.usage?.reasoningTokens, undefined);
});

test('K29-RADICAL/A: per-call reasoning overrides the gateway-global default', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), providerSort: '', reasoningEffort: '' });
  await call(gw, { reasoning: 'high' as never });
  assert.deepEqual(captured.body!.reasoning, { effort: 'high' });
  await call(gw, { reasoning: 'off' as never });
  assert.equal(captured.body!.reasoning, undefined, "'off' suppresses reasoning");
  await call(gw, { reasoning: 'low' as never });
  assert.deepEqual(captured.body!.reasoning, { effort: 'low' });
});

test('K29-RADICAL/B: per-call reasoning "off" suppresses even an env-default', async () => {
  const captured: Captured = {};
  // Simulate an env default by passing reasoningEffort=medium to the constructor; the
  // per-call off must win.
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), providerSort: '', reasoningEffort: 'medium' });
  await call(gw, { reasoning: 'off' as never });
  assert.equal(captured.body!.reasoning, undefined);
});

test('K29-RADICAL/C: invalid per-call reasoning is ignored (never forwarded)', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), providerSort: '', reasoningEffort: '' });
  await call(gw, { reasoning: 'turbo' as never });
  assert.equal(captured.body!.reasoning, undefined);
});

test('K29/G: tool calling and structured output remain untouched by the gateway', async () => {
  const captured: Captured = {};
  const gw = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: fakeFetch(captured), providerSort: 'throughput', reasoningEffort: 'low' });
  await call(gw);
  for (const key of ['tools', 'tool_choice', 'response_format', 'stream', 'stream_options', 'temperature']) {
    assert.equal(captured.body![key], undefined, `${key} must not be added by this change`);
  }
});

test('K29/H: timeout and provider-failure normalization are intact', async () => {
  const gw = new OpenRouterGateway({
    apiKey: 'test-key',
    defaultModel: 'm',
    chatTimeoutMs: 50,
    providerSort: 'throughput',
    fetchImpl: (async () => {
      const e = new Error('timed out');
      (e as { name: string }).name = 'TimeoutError';
      throw e;
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => call(gw), (e: unknown) => (e as { code?: string }).code === 'PROVIDER_CHAT_TIMEOUT');
  const gw2 = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'm', fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch });
  await assert.rejects(() => call(gw2), (e: unknown) => (e as { code?: string }).code === 'PROVIDER_CHAT_FAILED');
});