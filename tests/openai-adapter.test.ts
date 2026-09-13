import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiGateway } from '../src/platform/model-gateway/openai.gateway.ts';

/** Hermetic adapter test: OpenAI SDK is stubbed via the instance client method. */
test('openai adapter: maps SDK response into normalized output on success', async () => {
  const gateway = new OpenAiGateway({ apiKey: 'dummy-key', model: 'gpt-mini' });
  const inner = (gateway as unknown as { client: Record<string, unknown> }).client;
  (inner as any).chat = {
    completions: {
      create: async () => ({
        choices: [{ message: { content: 'hello there' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    },
  };

  const out = await gateway.generateText({
    projectId: 'p1',
    runId: 'r1',
    capability: 'platform.ai-echo',
    input: { message: 'hi' },
  });
  assert.equal(out.text, 'hello there');
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'gpt-mini');
  assert.ok(out.latencyMs !== undefined && out.latencyMs >= 0);
});

test('openai adapter: provider failure normalizes into `provider` error category', async () => {
  const gateway = new OpenAiGateway({ apiKey: 'dummy-key', model: 'gpt-mini' });
  const inner = (gateway as unknown as { client: Record<string, unknown> }).client;
  (inner as any).chat = {
    completions: {
      create: async () => {
        throw new Error('upstream boom');
      },
    },
  };

  let threw = false;
  try {
    await gateway.generateText({ projectId: 'p1', runId: 'r1', capability: 'platform.ai-echo', input: { message: 'x' } });
  } catch (e) {
    threw = true;
    assert.equal((e as { kind: string }).kind, 'provider');
  }
  assert.equal(threw, true);
});