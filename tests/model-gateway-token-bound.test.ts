/**
 * K25 slice 2 (option B) — ONE provider-neutral output bound across the boundary:
 *   workload/model need -> Model Gateway -> provider adapter (maps to `max_tokens`)
 *
 * Regression contract: callers that omit the bound behave exactly as before; the
 * adapter holds NO workload/provider policy; nothing provider-specific leaks down.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';
import { ResolvingModelGateway } from '../src/platform/model-gateway/resolving-gateway.ts';
import { createFiqhHaydSkill } from '../src/domain/naqaa/fiqh-hayd-skill.ts';
import { DECISION_MAX_OUTPUT_TOKENS, REASONING_MAX_OUTPUT_TOKENS } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';

const ok = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }], model: 'google/gemini-3.5-flash' }),
  text: async () => content,
}) as unknown as Response;

function captureAdapter() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return ok('{}');
  }) as unknown as typeof fetch;
  const gateway = new OpenRouterGateway({ apiKey: 'test-key', defaultModel: 'google/gemini-3.5-flash', fetchImpl });
  return { gateway, bodies };
}

const baseInput = { projectId: 'p', runId: 'r', capability: 'cap', modelId: 'google/gemini-3.5-flash', input: { message: 'hi' } };

describe('model gateway output bound (provider-neutral)', () => {
  it('1. an existing caller that omits the bound sends NO max_tokens (unchanged behaviour)', async () => {
    const { gateway, bodies } = captureAdapter();
    await gateway.generateText({ ...baseInput });
    assert.equal(bodies.length, 1);
    assert.equal('max_tokens' in bodies[0], false, JSON.stringify(bodies[0]));
    assert.deepEqual(Object.keys(bodies[0]).sort(), ['messages', 'model']);
  });

  it('2/3. an explicit bound is mapped verbatim to the provider field', async () => {
    const { gateway, bodies } = captureAdapter();
    await gateway.generateText({ ...baseInput, maxOutputTokens: DECISION_MAX_OUTPUT_TOKENS });
    assert.equal(bodies[0].max_tokens, DECISION_MAX_OUTPUT_TOKENS);
    assert.equal(DECISION_MAX_OUTPUT_TOKENS, 16384);
  });

  it('an unusable bound is ignored rather than forwarded', async () => {
    const { gateway, bodies } = captureAdapter();
    await gateway.generateText({ ...baseInput, maxOutputTokens: 0 });
    await gateway.generateText({ ...baseInput, maxOutputTokens: -5 });
    await gateway.generateText({ ...baseInput, maxOutputTokens: Number.NaN });
    assert.equal(bodies.every((b) => !('max_tokens' in b)), true, JSON.stringify(bodies));
  });

  it('the resolving gateway forwards the bound without inventing policy', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const resolving = new ResolvingModelGateway(
      { generateText: async (i: unknown) => { seen.push(i as Record<string, unknown>); return { text: 'x' }; }, embedTexts: async () => ({ vectors: [] }) } as never,
      { resolve: async () => ({ providerKey: 'openrouter', modelId: 'google/gemini-3.5-flash' }) } as never,
    );
    await resolving.generateText({ ...baseInput, modelId: undefined, maxOutputTokens: 2048 });
    assert.equal(seen[0].maxOutputTokens, 2048);
    await resolving.generateText({ ...baseInput });
    assert.equal('maxOutputTokens' in seen[1], false);
  });

  it('4. no provider-specific field leaks into the domain skill contracts', () => {
    const contracts = readFileSync('src/domain/naqaa/fiqh-hayd-contracts.ts', 'utf8');
    const skill = readFileSync('src/domain/naqaa/fiqh-hayd-skill.ts', 'utf8');
    assert.equal(/max_tokens/.test(contracts), false);
    assert.equal(/max_tokens/.test(skill), false);
    assert.equal(/openrouter/i.test(contracts), false);
    assert.equal(/openrouter/i.test(skill), false);
  });

  it('6. the provider adapter holds no workload/provider policy', () => {
    const adapter = readFileSync('src/platform/model-gateway/openrouter.gateway.ts', 'utf8');
    assert.equal(/workload\s*===/.test(adapter), false);
    assert.equal(/knowledge_answer/.test(adapter), false);
    assert.equal(/naqaa|fiqh|hayd/i.test(adapter), false);
  });

  it('every structured call of the K25 skill is bounded with its domain-owned value', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const passages = [
      { chunkId: 'c7', documentId: 'd', sourceId: 's1', sourceTitle: 'الحيض الالوكة', chunkIndex: 7, text: 'الصفرة والكدرة حيض على الأصح.', score: 0.03 },
      { chunkId: 'c8', documentId: 'd', sourceId: 's1', sourceTitle: 'الحيض الالوكة', chunkIndex: 8, text: 'إن كانت متصلة بالحيض فحيض وإلا فطهر.', score: 0.02 },
    ];
    const model = {
      async generateText(input: Record<string, unknown>) {
        calls.push(input);
        if (calls.length === 1) return { text: JSON.stringify({ issue: 'مسألة', queries: ['الصفرة والكدرة'] }) };
        if (calls.length === 2) return { text: JSON.stringify({ interpretations: [], requirements: [], unresolved: [] }) };
        return { text: JSON.stringify({
          status: 'DECIDED', category: 'طهر', directAnswer: 'ليس حيضًا.', explanation: 'للسبب.',
          confidence: 'LOW', sourceSupport: 'SUPPORTED', evidenceRefs: ['c7'], observationMappings: [], unresolved: [],
        }) };
      },
    };
    const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
    await skill.execute({
      projectId: 'p', actor: 'a', input: { text: 'حالة' },
      knowledge: { search: async () => passages, resolveSources: async () => [{ id: 's1', title: 'الحيض الالوكة' }], adjacent: async () => [] },
      model,
    } as never);
    // planner + interpreter carry the reasoned bound; the ruling call carries its own
    assert.equal(calls.length, 3);
    assert.equal(calls[0].maxOutputTokens, REASONING_MAX_OUTPUT_TOKENS);
    assert.equal(calls[1].maxOutputTokens, REASONING_MAX_OUTPUT_TOKENS);
    assert.equal(calls[2].maxOutputTokens, DECISION_MAX_OUTPUT_TOKENS);
    assert.equal(calls.every((c) => c.workload === 'knowledge_answer'), true);
    assert.equal([calls[0].maxOutputTokens, calls[1].maxOutputTokens, calls[2].maxOutputTokens].every((v) => typeof v === 'number' && v > 0 && v < 65536), true);
    // the bound is a plain number, never a provider field name
    assert.equal(calls.every((c) => typeof c.maxOutputTokens === 'number'), true);
    assert.equal(calls.every((c) => !('max_tokens' in c)), true);
  });
});
