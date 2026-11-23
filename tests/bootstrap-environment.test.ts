import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapEnvironment } from '../src/platform/bootstrap/environment.ts';

test('bootstrap environment maps server credentials without exposing a browser configuration', () => {
  const environment = bootstrapEnvironment({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'synthetic-secret',
    MODEL_NAME: 'synthetic/model',
    KIP_API_TOKENS: 'developer:legacy-token',
    KIP_PROXY_TOKENS: 'naqaa-service:proxy-token',
    KIP_FRONTEND_URL: 'https://admin.example.test',
  });

  assert.equal(environment.supabaseUrl, 'https://example.supabase.co');
  assert.equal(environment.supabaseSecretKey, 'synthetic-secret');
  assert.equal(environment.openRouterModel, 'synthetic/model');
  assert.equal(environment.tokenActors?.get('legacy-token'), 'developer');
  assert.equal(environment.proxyTokens?.get('proxy-token'), 'naqaa-service');
  assert.equal(environment.frontendUrl, 'https://admin.example.test');
  assert.equal(environment.githubApp, null);
});

test('bootstrap environment uses deployment-safe defaults when optional values are absent', () => {
  const environment = bootstrapEnvironment({});

  assert.equal(environment.supabaseUrl, '');
  assert.equal(environment.supabaseSecretKey, '');
  assert.equal(environment.openRouterModel, 'openrouter/auto');
  assert.equal(environment.frontendUrl, 'http://localhost:5173');
  assert.equal(environment.tokenActors?.size, 0);
  assert.equal(environment.proxyTokens?.size, 0);
  assert.equal(environment.githubApp, null);
});
