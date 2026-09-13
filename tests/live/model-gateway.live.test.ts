import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterGateway } from '../../src/platform/model-gateway/openrouter.gateway.ts';

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.MODEL_NAME ?? 'openrouter/auto';

test('live openrouter: validateKey with a valid credential returns true (zero-cost)', { skip: !apiKey }, async () => {
  const gw = new OpenRouterGateway({ apiKey: apiKey!, defaultModel: model });
  const ok = await gw.validateKey();
  assert.equal(ok, true);
});

test('live openrouter: validateKey with an invalid credential returns false', { skip: !apiKey }, async () => {
  const gw = new OpenRouterGateway({ apiKey: 'or-invalid-key-0000', defaultModel: model });
  const ok = await gw.validateKey();
  assert.equal(ok, false);
});

test('live openrouter: models list is reachable and returns ids', { skip: !apiKey }, async () => {
  const gw = new OpenRouterGateway({ apiKey: apiKey!, defaultModel: model });
  const models = await gw.listModels();
  assert.ok(models.length > 0);
  assert.ok(models[0].id.length > 0);
});