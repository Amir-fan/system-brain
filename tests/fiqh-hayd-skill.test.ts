/**
 * K25 slice 1 — Shafi'i fiqh skill (menstruation family): SOURCE-GROUNDED reasoning.
 *
 * These tests are deterministic: the model and the knowledge capability are both
 * scripted, so the CODE guarantees are what is under test — approved-source
 * restriction, citation-required materiality, never re-asking a known fact,
 * SOURCE_GAP instead of guessing, and dynamic (not fixed) requirement sets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFiqhHaydSkill } from '../src/domain/naqaa/fiqh-hayd-skill.ts';
import { APPROVED_SOURCE_TITLES, FIQH_HAYD_SKILL_ID } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';
import { SkillsRuntime } from '../src/core/skill/skill-runtime.ts';
import { MapSkillRegistry } from '../src/core/skill/skill-registry.ts';
import type { SkillDefinition } from '../src/core/skill/skill.ts';
import type { RunRecord } from '../src/core/runtime/runtime.ports.ts';

const APPROVED_ID = 'src-approved-1';
const UNAPPROVED_ID = 'src-unapproved-9';

const passage = (chunkId: string, sourceId: string, text: string, score = 0.03) => ({
  chunkId, documentId: 'doc-1', sourceId, sourceTitle: sourceId === APPROVED_ID ? 'الحيض الالوكة' : 'التشجير',
  chunkIndex: 7, text, score,
});

function fakeKnowledge(opts: {
  approved?: Array<{ id: string; title: string }>;
  byQuery?: Record<string, ReturnType<typeof passage>[]>;
  adjacent?: Record<string, ReturnType<typeof passage>[]>;
} = {}) {
  const calls = { search: [] as Array<{ query: string; sourceIds?: string[] }>, adjacent: [] as string[] };
  const approved = opts.approved ?? [{ id: APPROVED_ID, title: APPROVED_SOURCE_TITLES[0] }];
  const cap = {
    async search({ query, sourceIds }: { query: string; topK?: number; sourceIds?: string[] }) {
      calls.search.push({ query, sourceIds });
      const hits = opts.byQuery?.[query] ?? [passage('chunk-7', APPROVED_ID, 'الصفرة والكدرة ليسا من ألوان الدم… وقد اختلف العلماء فقال الشافعية: الكدرة والصفرة حيض على الأصح المعتمد.')];
      // A conforming adapter filters by sourceIds; this fake ALSO proves the skill asked.
      return sourceIds ? hits.filter((h) => sourceIds.includes(h.sourceId)) : hits;
    },
    async resolveSources(titles: string[]) {
      return approved.filter((s) => titles.includes(s.title));
    },
    async adjacent(chunkId: string) {
      calls.adjacent.push(chunkId);
      return opts.adjacent?.[chunkId] ?? [passage('chunk-8', APPROVED_ID, 'والراجح والله أعلم: أن الصفرة والكدرة إن كانت متصلة بالحيض فحيض وإلا فطهر.')];
    },
  };
  return { cap, calls };
}

function fakeModel(responses: string[]) {
  const calls: Array<{ workload: string; message: string }> = [];
  const cap = {
    async generateText({ workload, message }: { workload: string; message?: string }) {
      calls.push({ workload, message: message ?? '' });
      return { text: responses.shift() ?? '{}' };
    },
  };
  return { cap, calls };
}

const plan = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    issue: 'حكم إفرازة في آخر أيام الحيض',
    queries: ['الصفرة والكدرة', 'اتصال الإفراز بالحيض'],
    interpretations: [{ observation: 'سائل شفاف مع لمعة حمراء خفيفة', candidateConcept: '', supported: false, citations: [] }],
    requirements: [],
    unresolved: ['لا يعرّف المصدر «سائل شفاف مع لمعة حمراء»'],
    ...over,
  });

const planner = JSON.stringify({ issue: 'حكم إفرازة في آخر أيام الحيض', queries: ['الصفرة والكدرة', 'اتصال الإفراز بالحيض'] });

async function run(responsePlan: string, input: Record<string, unknown> = {}, knowledge = fakeKnowledge()) {
  const model = fakeModel([planner, responsePlan]);
  const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
  const out = (await skill.execute({
    projectId: 'p1', actor: 'a1', input,
    knowledge: knowledge.cap, model: model.cap,
  } as never)) as Record<string, unknown>;
  return { out, model, knowledge };
}

describe('K25 fiqh skill — source-grounded reasoning', () => {
  it('declares knowledge + model requirements and never a static questionnaire', () => {
    const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
    assert.equal(skill.id, FIQH_HAYD_SKILL_ID);
    assert.equal(skill.requirements.knowledge, true);
    assert.equal(skill.requirements.model, true);
    assert.equal(skill.readiness, undefined, 'requirements must be derived, not statically declared');
  });

  it('retrieves ONLY from the approved source set (identity, not just role)', async () => {
    const knowledge = fakeKnowledge({
      byQuery: {
        'الصفرة والكدرة': [passage('chunk-unapproved', UNAPPROVED_ID, 'الحكم: الدم القوي حيض والدم الضعيف طهر')],
        'اتصال الإفراز بالحيض': [passage('chunk-8', APPROVED_ID, 'والراجح والله أعلم: أن الصفرة والكدرة إن كانت متصلة بالحيض فحيض وإلا فطهر.')],
      },
    });
    const { out, knowledge: k } = await run(plan(), {}, knowledge);
    // every search was restricted to the approved ids
    assert.ok(k.calls.search.length > 0);
    assert.ok(k.calls.search.every((c) => Array.isArray(c.sourceIds) && c.sourceIds.length === 1 && c.sourceIds[0] === APPROVED_ID));
    // and no unapproved chunk reached the evidence/trace
    const ids = (out.evidenceChunkIds as string[]) ?? [];
    assert.ok(!ids.includes('chunk-unapproved'));
    assert.deepEqual(out.approvedSourceIds, [APPROVED_ID]);
  });

  it('drops an uncited requirement (materiality requires a source citation)', async () => {
    const { out } = await run(plan({
      requirements: [{ key: 'bleeding_cessation', whyMaterial: 'x', question: { wording: 'سؤال؟' }, interaction: { type: 'yes_no' }, citations: [] }],
    }));
    assert.deepEqual(out.requirementKeys, []);
    assert.ok((out.sourceGap as { notes: string[] }).notes.some((n) => n.startsWith('uncited_requirement')));
  });

  it('never re-asks a fact that is already known (structured context)', async () => {
    const { out } = await run(
      plan({
        requirements: [{
          key: 'bleeding_cessation', whyMaterial: 'اتصال الإفراز بالحيض',
          question: { wording: 'قبل ما تشوفين هذا السائل، كان الدم وقف تمامًا أو كان ما زال ينزل؟' },
          interaction: { type: 'single_choice', options: ['توقف', 'كان ينزل'] },
          citations: ['chunk-7'],
        }],
      }),
      { context: { bleeding_cessation: true }, factMeta: { bleeding_cessation: { certainty: 'CERTAIN', provenance: 'user_answer' } } },
    );
    assert.deepEqual(out.requirementKeys, []);
    // B1.1/K-1: the drop is CERTAINTY-aware now — a CERTAIN case value satisfies the need.
    assert.ok((out.sourceGap as { notes: string[] }).notes.includes('already_satisfied:bleeding_cessation'));
    // The case is decision-ready, so the skill proceeds to the decision step; with no
    // usable grounded proposal it returns SOURCE_GAP rather than a ruling.
    assert.equal((out.readiness as { status: string }).status, 'READY_FOR_DECISION');
    assert.equal(out.status, 'SOURCE_GAP');
    assert.equal((out.decision as { status: string }).status, 'SOURCE_GAP');
  });

  it('B1.1/K-2: an UNVERIFIED knownFromCase claim cannot drop a material need', async () => {
    const { out } = await run(plan({
      requirements: [{
        key: 'bleeding_cessation', whyMaterial: 'اتصال الإفراز بالحيض',
        question: { wording: 'هل توقف الدم؟' }, interaction: { type: 'yes_no' }, citations: ['chunk-7'],
        knownFromCase: true,
      }],
    }));
    // No trustworthy value supports the claim, so the need stays material AND askable...
    assert.deepEqual(out.requirementKeys, ['bleeding_cessation']);
    assert.equal((out.readiness as { status: string }).status, 'NEEDS_INFORMATION');
    // ...and the unverified claim is recorded rather than silently obeyed.
    assert.ok((out.sourceGap as { notes: string[] }).notes.includes('unproven_known_from_case:bleeding_cessation'));
  });

  it('derives a DIFFERENT requirement set per case (dynamic, not a fixed questionnaire)', async () => {
    const req = (key: string, wording: string) => ({
      key, whyMaterial: 'شرط في المصدر', question: { wording }, interaction: { type: 'yes_no' }, citations: ['chunk-7'],
    });
    const a = await run(plan({ requirements: [req('post_bleeding_dryness', 'هل جفّ المكان؟')] }));
    const b = await run(plan({ requirements: [req('bleeding_duration_days', 'كم يومًا استمر الدم؟'), req('habit_days', 'كم يومًا عادتك؟')] }));
    assert.deepEqual(a.out.requirementKeys, ['post_bleeding_dryness']);
    assert.deepEqual(b.out.requirementKeys, ['bleeding_duration_days', 'habit_days']);
  });

  it('sends the derived requirements through the K22 readiness contract with a human question + control', async () => {
    const { out } = await run(plan({
      requirements: [{
        key: 'bleeding_cessation', whyMaterial: 'شرط الاتصال',
        question: { wording: 'قبل ما تشوفين هذا السائل، كان الدم وقف تمامًا أو كان ما زال ينزل؟' },
        interaction: { type: 'single_choice', options: ['توقف تمامًا', 'كان ينزل'] },
        citations: ['chunk-7'],
      }],
    }));
    const readiness = out.readiness as { status: string; missing: Array<{ key: string; question?: { wording: string }; interaction?: { type: string } }> };
    assert.equal(readiness.status, 'NEEDS_INFORMATION');
    assert.equal(readiness.missing[0].key, 'bleeding_cessation');
    assert.match(readiness.missing[0].question!.wording, /وقف تمامًا/);
    // B1.0/G1: bleeding_cessation's answer kind is Skill-owned (canonical yes_no), so the
    // model's single_choice declaration cannot weaken it; the question wording still travels.
    assert.equal(readiness.missing[0].interaction!.type, 'yes_no');
    assert.equal(out.status, 'NEEDS_INFORMATION');
  });

  it('preserves an observation the approved source does not define as SOURCE_GAP (never a guess)', async () => {
    const { out } = await run(plan());
    const gaps = out.sourceGap as { present: boolean; observations: string[]; notes: string[] };
    assert.equal(gaps.present, true);
    assert.ok(gaps.observations.some((o) => o.includes('سائل شفاف')));
    const interps = out.interpretations as Array<{ supported: boolean }>;
    assert.equal(interps[0].supported, false);
    // the decision step must not produce a ruling out of an undefined observation
    assert.equal((out.decision as { status: string }).status, 'SOURCE_GAP');
  });

  it('treats a missing approved source as SOURCE_GAP (nothing to ground on)', async () => {
    const { out } = await run(plan(), {}, fakeKnowledge({ approved: [] }));
    assert.equal(out.status, 'SOURCE_GAP');
    assert.deepEqual(out.evidenceChunkIds, []);
    assert.ok((out.sourceGap as { notes: string[] }).notes.includes('approved_sources_missing'));
  });

  it('never fabricates when the reasoning output is unusable', async () => {
    const { out } = await run('هذا ليس JSON');
    assert.equal(out.status, 'SOURCE_GAP');
    assert.deepEqual(out.requirementKeys, []);
    assert.ok((out.sourceGap as { notes: string[] }).notes.some((n) => n.startsWith('reasoning_output_unusable')));
  });

  it('uses bounded adjacent context when a source statement spans chunks', async () => {
    const { knowledge } = await run(plan());
    assert.ok(knowledge.calls.adjacent.length > 0, 'adjacency was requested for the strongest passage');
    assert.ok(knowledge.calls.adjacent.length <= 2, 'adjacency stays bounded');
  });
});

describe('K25 runtime wiring', () => {
  function fakePersistence() {
    const runs: Record<string, RunRecord> = {};
    return {
      runs,
      async getProject(id: string) { return id === 'p1' ? { id, name: 'P', status: 'active' as const, createdAt: '', updatedAt: '' } : null; },
      async getMembership(projectId: string, actor: string) { return { projectId, actor, role: 'owner' as const, createdAt: '' }; },
      async createRun(run: RunRecord) { runs[run.id] = run; },
      async updateRun(id: string, patch: Partial<RunRecord>) { runs[id] = { ...(runs[id] ?? { id }), ...patch } as RunRecord; },
    };
  }

  const knowledgeSkill = (): SkillDefinition => ({
    id: 'test.knowledge-skill',
    version: 1,
    description: 'test',
    requirements: { understanding: false, memory: false, knowledge: true, model: false },
    validateInput: () => ({ ok: true }),
    validateOutput: () => ({ ok: true }),
    async execute(ctx) {
      return { hasKnowledge: Boolean(ctx.knowledge), projectScoped: (ctx.knowledge as unknown as { projectId?: string })?.projectId };
    },
  });

  it('refuses to run a knowledge-declaring skill when knowledge is not wired', async () => {
    const reg = new MapSkillRegistry();
    reg.register(knowledgeSkill());
    const runtime = new SkillsRuntime({ persistence: fakePersistence(), registry: reg });
    let surface = '';
    try {
      await runtime.execute({ projectId: 'p1', actor: 'a1', skillId: 'test.knowledge-skill', payload: {} });
    } catch (e) {
      // SkillFailure carries its detail in the stack, not in .cause.
      surface = `${String((e as Error).message)}
${String((e as Error).stack ?? '')}`;
    }
    assert.match(surface, /knowledge required but not wired/);
  });

  it('binds the PROJECT id into the capability (the skill cannot cross projects)', async () => {
    const seen: string[] = [];
    const reg = new MapSkillRegistry();
    reg.register(knowledgeSkill());
    const runtime = new SkillsRuntime({
      persistence: fakePersistence(),
      registry: reg,
      knowledge: (projectId) => {
        seen.push(projectId);
        return { projectId, search: async () => [], resolveSources: async () => [], adjacent: async () => [] } as never;
      },
    });
    const r = await runtime.execute({ projectId: 'p1', actor: 'a1', skillId: 'test.knowledge-skill', payload: {} });
    assert.equal(r.status, 'completed');
    assert.deepEqual(seen, ['p1']);
    assert.equal((r.output as { hasKnowledge: boolean }).hasKnowledge, true);
    assert.equal((r.output as { projectScoped: string }).projectScoped, 'p1');
  });
});
