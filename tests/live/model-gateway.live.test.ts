import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiGateway } from '../../src/platform/model-gateway/openai.gateway.ts';

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.MODEL_NAME ?? 'gpt-4o-mini';

test('live provider: real OpenAI call succeeds and normalizes output', { skip: !apiKey }, async () => {
  const gateway = new OpenAiGateway({ apiKey: apiKey!, model });
  const out = await gateway.generateText({
    projectId: 'p-live',
    runId: `live-${Date.now()}`,
    capability: 'platform.ai-echo',
    input: { message: 'Reply with the single word: ok' },
    model: { profile: 'fast' },
  });
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, model);
  assert.ok(out.text.length > 0, 'expected a non-empty model response');
  assert.ok(out.latencyMs !== undefined);
  assert.ok(out.usage && out.usage.totalTokens! > 0, 'expected token usage');
});

test('live provider: auth failure normalizes into provider error', { skip: !apiKey }, async () => {
  const gateway = new OpenAiGateway({ apiKey: 'sk-invalid-not-a-real-key', model });
  let threw = false;
  try {
    await gateway.generateText({ projectId: 'p-live', runId: 'live-x', capability: 'platform.ai-echo', input: { message: 'x' } });
  } catch (e) {
    threw = true;
    assert.equal((e as { kind: string }).kind, 'provider');
  }
  assert.equal(threw, true);
});