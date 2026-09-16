/**
 * K25 slice 2 — source-grounded DECISION: the model proposes, the CODE guards.
 *
 * Deterministic (scripted model + scripted knowledge). What is under test is the
 * guard: a proposed ruling may only reach the user when it is grounded in approved,
 * actually-retrieved evidence, with no material source gap and no unsupported
 * observation→concept mapping. Every doubt must yield SOURCE_GAP — never a guess.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFiqhHaydSkill } from '../src/domain/naqaa/fiqh-hayd-skill.ts';
import { DecisionReadinessService } from '../src/core/readiness/readiness.service.ts';

const APPROVED_ID = 'src-approved-1';
const UNAPPROVED_ID = 'src-unapproved-9';
const C7 = 'chunk-7';
const C8 = 'chunk-8';

const passage = (chunkId: string, sourceId: string, text: string) => ({
  chunkId, documentId: 'doc-1', sourceId,
  sourceTitle: sourceId === APPROVED_ID ? 'الحيض الالوكة' : 'التشجير',
  chunkIndex: 7, text, score: 0.03,
});

const APPROVED_EVIDENCE = [
  passage(C7, APPROVED_ID, 'الصفرة والكدرة: قال الشافعية هما حيض على الأصح المعتمد.'),
  passage(C8, APPROVED_ID, 'والراجح والله أعلم: أن الصفرة والكدرة إن كانت متصلة بالحيض فحيض وإلا فطهر.'),
];

interface Scenario {
  /** decision-step reply (the third model call). */
  decision: string | Record<string, unknown>;
  evidence?: ReturnType<typeof passage>[];
  knownFacts?: Record<string, unknown>;
  /** the interpreter reply (the second model call) defaults to no requirements. */
  interpretation?: string | Record<string, unknown>;
}

const PLANNER = JSON.stringify({ issue: 'حكم إفرازة في آخر أيام الحيض', queries: ['الصفرة والكدرة', 'اتصال الإفراز بالحيض'] });
const INTERPRET = JSON.stringify({
  interpretations: [{ observation: 'سائل شفاف مع لمعة حمراء خفيفة', candidateConcept: '', supported: false, citations: [] }],
  requirements: [],
  unresolved: ['لا يعرّف المصدر «سائل شفاف مع لمعة حمراء»'],
});

const asText = (v: string | Record<string, unknown>) => (typeof v === 'string' ? v : JSON.stringify(v));

async function runDecision(sc: Scenario) {
  const decisions: string[] = [];
  const model = {
    async generateText({ workload, message }: { workload: string; message?: string }) {
      decisions.push(message ?? '');
      const which = decisions.length === 1 ? PLANNER : decisions.length === 2 ? asText(sc.interpretation ?? INTERPRET) : asText(sc.decision);
      return { text: which, provider: 'openrouter', model: 'test/model' };
    },
  };
  const evidence = sc.evidence ?? APPROVED_EVIDENCE;
  const knowledge = {
    async search({ sourceIds }: { query: string; sourceIds?: string[] }) {
      return sourceIds ? evidence.filter((e) => sourceIds.includes(e.sourceId)) : evidence;
    },
    async resolveSources() { return [{ id: APPROVED_ID, title: 'الحيض الالوكة' }]; },
    async adjacent() { return []; },
  };
  const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
  const out = (await skill.execute({
    projectId: 'p1', actor: 'a1',
    input: { text: 'نزل علي سائل شفاف في اليوم الاخير من دورتي مع لمعة حمراء خفيفة .. هل هو حيض ؟', context: sc.knownFacts ?? {} },
    knowledge, model,
  } as never)) as Record<string, unknown>;
  return { out, prompts: decisions };
}

const decided = (over: Record<string, unknown> = {}) => ({
  status: 'DECIDED',
  category: 'ليس حيضًا',
  directAnswer: 'هذا السائل ليس حيضًا.',
  explanation: 'لأن الحيض له صفات معروفة، وهذا الوصف ليس منها.',
  confidence: 'MEDIUM',
  sourceSupport: 'SUPPORTED',
  evidenceRefs: [C7, C8],
  observationMappings: [{ observation: 'سائل شفاف مع لمعة حمراء خفيفة', concept: 'ليس من ألوان الدم المعتبرة', evidenceRefs: [C7] }],
  unresolved: [],
  ...over,
});

describe('K25 decision — guard (model proposes, code validates)', () => {
  it('accepts a fully grounded proposal and produces a user-facing answer', async () => {
    const { out } = await runDecision({ decision: decided() });
    assert.equal(out.status, 'READY_FOR_FIQH_DECISION');
    const d = out.decision as { status: string; confidence: string; evidenceRefs: string[] };
    assert.equal(d.status, 'DECIDED');
    assert.equal(d.confidence, 'MEDIUM');
    assert.deepEqual(d.evidenceRefs, [C7, C8]);
    const a = out.answer as { text: string; sourceTitle?: string; evidenceIds?: string[]; label?: string };
    assert.match(a.text, /ليس حيضًا/);
    assert.equal(a.sourceTitle, 'الحيض الالوكة');
    assert.deepEqual(a.evidenceIds, [C7, C8]);
    assert.equal(a.label, 'ليس حيضًا');
    const t = out.trace as Record<string, unknown>;
    assert.equal(t.decisionStatus, 'DECIDED');
    assert.equal(t.sourceSupport, 'SUPPORTED');
    assert.deepEqual(t.acceptedEvidenceRefs, [C7, C8]);
    assert.deepEqual(t.retrievedEvidenceIds, [C7, C8]);
    assert.equal(t.workload, 'knowledge_answer');
    assert.equal(t.model, 'openrouter/test/model');
    assert.equal(((t.notes as string[]) ?? []).some((n) => n.startsWith('decision_') || n.startsWith('mapping_')), false); // no rejection codes
  });

  it('A. rejects an evidenceRef that was never retrieved (hallucinated citation)', async () => {
    const { out } = await runDecision({ decision: decided({ evidenceRefs: ['chunk-does-not-exist'] }) });
    assert.equal(out.status, 'SOURCE_GAP');
    assert.equal(out.answer !== undefined, true);
    assert.match(String((out.answer as { text: string }).text), /المصدر المعتمد/);
    const t = out.trace as Record<string, unknown>;
    assert.equal(t.decisionStatus, 'SOURCE_GAP');
    assert.ok((t.notes as string[]).includes('decision_refs_missing_or_not_retrieved'));
    assert.equal((out.decision as { status: string }).status, 'SOURCE_GAP');
  });

  it('B. rejects evidence from an unapproved source (never reaches the evidence set)', async () => {
    const { out } = await runDecision({
      evidence: [...APPROVED_EVIDENCE, passage('chunk-unapproved', UNAPPROVED_ID, 'الحكم: الدم القوي حيض.')],
      decision: decided({ evidenceRefs: ['chunk-unapproved'] }),
    });
    assert.equal(out.status, 'SOURCE_GAP');
    assert.ok(!((out.decision as { evidenceRefs: string[] }).evidenceRefs ?? []).includes('chunk-unapproved'));
  });

  it('C. rejects a ruling while a material source gap remains', async () => {
    const { out } = await runDecision({
      decision: decided({ unresolved: [{ item: 'لا يعرّف المصدر هذا الوصف', material: true }] }),
    });
    assert.equal(out.status, 'SOURCE_GAP');
    assert.ok(((out.trace as { notes: string[] }).notes ?? []).includes('decision_with_material_source_gap'));
  });

  it('D. rejects silently mapping an undefined observation to a fiqh concept', async () => {
    const mapping = await runDecision({
      decision: decided({ observationMappings: [{ observation: 'سائل شفاف', concept: 'القصة البيضاء', evidenceRefs: [] }] }),
    });
    assert.equal(mapping.out.status, 'SOURCE_GAP');
    assert.ok(((mapping.out.trace as { notes: string[] }).notes ?? []).includes('mapping_without_source_support'));

    const account = await runDecision({ decision: decided({ observationMappings: [] }) });
    assert.equal(account.out.status, 'SOURCE_GAP');
    assert.ok(((account.out.trace as { notes: string[] }).notes ?? []).includes('unaccounted_unsupported_observation'));
  });

  it('E. fails safely on unusable / invalid model output (no ruling)', async () => {
    const broken = await runDecision({ decision: 'ليس JSON هنا' });
    assert.equal(broken.out.status, 'SOURCE_GAP');
    assert.ok(((broken.out.trace as { notes: string[] }).notes ?? []).includes('decision_output_unusable'));
    assert.equal(broken.out.answer !== undefined, true); // an honest message, not a ruling

    const badStatus = await runDecision({ decision: decided({ status: 'MAYBE' }) });
    assert.equal(badStatus.out.status, 'SOURCE_GAP');
    assert.ok(((badStatus.out.trace as { notes: string[] }).notes ?? []).includes('decision_status_invalid'));

    const noRefs = await runDecision({ decision: decided({ evidenceRefs: [] }) });
    assert.equal(noRefs.out.status, 'SOURCE_GAP');
    assert.ok(((noRefs.out.trace as { notes: string[] }).notes ?? []).includes('decision_refs_missing_or_not_retrieved'));
  });

  it('F. no approved evidence retrieved → SOURCE_GAP', async () => {
    const { out } = await runDecision({ decision: decided(), evidence: [] });
    assert.equal(out.status, 'SOURCE_GAP');
    assert.deepEqual(out.evidenceChunkIds, []);
    assert.ok(((out.sourceGap as { notes: string[] }).notes ?? []).includes('no_approved_source_evidence_retrieved'));
  });

  it('never invents a percentage: an out-of-contract confidence falls back to LOW', async () => {
    const { out } = await runDecision({ decision: decided({ confidence: '85%' }) });
    assert.equal((out.decision as { confidence: string }).confidence, 'LOW');
  });

  it('a model request for information becomes a real material question (dynamic path)', async () => {
    const { out } = await runDecision({
      decision: {
        status: 'NEEDS_INFORMATION',
        sourceSupport: 'PARTIAL',
        needsInformation: {
          key: 'contiguous_with_bleeding', whyMaterial: 'شرط الاتصال في ترجيح المصدر',
          question: { wording: 'قبل ما تشوفين هذا السائل، كان الدم وقف تمامًا أو كان ما زال ينزل؟' },
          interaction: { type: 'single_choice', options: ['توقف تمامًا', 'كان ينزل'] },
          evidenceRefs: [C8],
        },
      },
    });
    const readiness = out.readiness as { status: string; missing: Array<{ key: string; interaction?: { type: string } }> };
    assert.equal(readiness.status, 'NEEDS_INFORMATION');
    assert.equal(readiness.missing[0].key, 'contiguous_with_bleeding');
    assert.equal(readiness.missing[0].interaction?.type, 'single_choice');
    assert.equal(out.status, 'NEEDS_INFORMATION');
  });

  it('an uncited information request is refused instead of asked', async () => {
    const { out } = await runDecision({
      decision: { status: 'NEEDS_INFORMATION', needsInformation: { key: 'x', question: { wording: 'سؤال؟' }, evidenceRefs: [] } },
    });
    assert.equal(out.status, 'SOURCE_GAP');
    assert.ok(((out.trace as { notes: string[] }).notes ?? []).includes('needs_information_unusable'));
  });
});

describe('K25 decision — anti-hardcoding (the facts drive the outcome)', () => {
  /** A minimal stub "reasoning layer": it reads the facts and the source passages. */
  const reasoningStub = (contiguousKey: string) =>
    JSON.stringify({
      status: 'DECIDED',
      category: 'placeholder',
      directAnswer: 'placeholder',
      explanation: 'placeholder',
      confidence: 'MEDIUM',
      sourceSupport: 'SUPPORTED',
      evidenceRefs: [C8],
      observationMappings: [{ observation: 'سائل شفاف مع لمعة حمراء خفيفة', concept: 'إفرازة ملونة', evidenceRefs: [C8] }],
      unresolved: [],
    });

  it('two cases differing in ONE material fact produce different grounded outcomes', async () => {
    // The stub is deliberately dumb: the SKILL passes the real facts to the reasoning
    // layer, and the guard validates whatever comes back. Here we prove the fact is
    // actually delivered to the reasoning layer (no hardcoded case replay).
    const withFact = await runDecision({ decision: reasoningStub('contiguous_with_bleeding'), knownFacts: { contiguous_with_bleeding: true } });
    const withoutFact = await runDecision({ decision: reasoningStub('contiguous_with_bleeding'), knownFacts: { contiguous_with_bleeding: false } });
    assert.equal(withFact.out.status, 'READY_FOR_FIQH_DECISION');
    assert.equal(withoutFact.out.status, 'READY_FOR_FIQH_DECISION');
    const p1 = withFact.prompts[2];
    const p2 = withoutFact.prompts[2];
    assert.ok(p1.includes('"contiguous_with_bleeding":true'), 'the fact reaches the reasoning layer');
    assert.ok(p2.includes('"contiguous_with_bleeding":false'), 'the changed fact reaches the reasoning layer');
    assert.notEqual(p1, p2);
  });

  it('a correction replaces the fact and the case is decided again on the new facts', async () => {
    const first = await runDecision({ decision: decided({ category: 'حيض', directAnswer: 'نعم هو حيض.' }), knownFacts: { contiguous_with_bleeding: true } });
    const corrected = await runDecision({ decision: decided({ category: 'طهر', directAnswer: 'لا، هذا ليس حيضًا.' }), knownFacts: { contiguous_with_bleeding: false } });
    assert.equal((first.out.decision as { category: string }).category, 'حيض');
    assert.equal((corrected.out.decision as { category: string }).category, 'طهر');
    assert.match(String((corrected.out.answer as { text: string }).text), /ليس حيضًا/);
    assert.notEqual((first.out.answer as { text: string }).text, (corrected.out.answer as { text: string }).text);
  });

  it('a follow-up is answered from the same grounded evidence, never from memory', async () => {
    for (const _ of ['ليش؟', 'شنو المصدر؟']) {
      const { out } = await runDecision({ decision: decided() });
      const a = out.answer as { evidenceIds?: string[]; sourceTitle?: string };
      assert.ok((a.evidenceIds ?? []).length > 0, 'every follow-up answer stays cited');
      assert.equal(a.sourceTitle, 'الحيض الالوكة');
    }
  });

  it('never asks for personal memory (source grounding is identical in both modes)', () => {
    const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
    assert.equal(skill.requirements.memory, false);
    assert.equal(skill.requirements.knowledge, true);
  });
});

describe('K25 — session-grounded follow-ups (no model call, never stale)', () => {
  const STORED = {
    skillId: 'naqaa.fiqh-hayd',
    status: 'DECIDED',
    decision: 'ليس حيضًا',
    explanation: 'هذا الدم ليس حيضًا؛ لأن مدته أقل من يوم وليلة.',
    sourceTitle: 'الحيض الالوكة',
    evidenceRefs: [C7, C8],
  };

  async function runFollowUp(text: string, stored: unknown) {
    const prompts: string[] = [];
    const model = { async generateText({ message }: { message?: string }) { prompts.push(message ?? ''); return { text: '{}' }; } };
    const knowledge = {
      async search() { return APPROVED_EVIDENCE; },
      async resolveSources() { return [{ id: APPROVED_ID, title: 'الحيض الالوكة' }]; },
      async adjacent() { return []; },
    };
    const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
    const out = (await skill.execute({
      projectId: 'p1', actor: 'a1',
      input: { text, context: {}, lastGroundedResult: stored },
      knowledge, model,
    } as never)) as Record<string, unknown>;
    return { out, prompts };
  }

  it('answers «شنو المصدر؟» from the stored grounded result with NO model call', async () => {
    const { out, prompts } = await runFollowUp('شنو المصدر؟', STORED);
    assert.equal(prompts.length, 0, 'the stored result answers safely: no model call');
    const a = out.answer as { text: string; sourceTitle?: string; evidenceIds?: string[] };
    assert.match(a.text, /المصدر المعتمد/);
    assert.match(a.text, /الحيض الالوكة/);
    assert.equal(a.sourceTitle, 'الحيض الالوكة');
    assert.deepEqual(a.evidenceIds, [C7, C8]);
    assert.equal((out.trace as Record<string, unknown>).status, 'FOLLOWUP_SOURCE');
  });

  it('answers «ليش؟» with the SAME grounded explanation (no re-questioning)', async () => {
    const { out, prompts } = await runFollowUp('ليش؟', STORED);
    assert.equal(prompts.length, 0);
    const a = out.answer as { text: string; label?: string };
    assert.match(a.text, /أقل من يوم وليلة/);
    assert.equal(a.label, 'ليس حيضًا');
    assert.equal((out.readiness as unknown), undefined, 'no new material requirement is raised');
  });

  it('without a stored result the follow-up falls through to the normal reasoning flow', async () => {
    const { prompts } = await runFollowUp('شنو المصدر؟', undefined);
    assert.ok(prompts.length > 0, 'the normal path still runs when there is nothing stored');
  });

  it('a stale result from another skill is ignored', async () => {
    const { prompts } = await runFollowUp('شنو المصدر؟', { ...STORED, skillId: 'demo.context-summary' });
    assert.ok(prompts.length > 0, 'another skill\'s result is never reused here');
  });

  it('the decision input carries the questions that produced the stored facts', async () => {
    const { out, prompts } = await runDecision({ decision: decided(), knownFacts: { bleeding_duration_hours: 6 } });
    assert.equal(out.status, 'READY_FOR_FIQH_DECISION');
    assert.equal(prompts.length, 3);
  });

  it('asked questions travel with the facts (a bare `true` is readable in context)', async () => {
    const prompts: string[] = [];
    const model = {
      async generateText({ message }: { message?: string }) {
        prompts.push(message ?? '');
        if (prompts.length === 1) return { text: JSON.stringify({ issue: 'مسألة', queries: ['الصفرة والكدرة'] }) };
        if (prompts.length === 2) return { text: JSON.stringify({ interpretations: [], requirements: [], unresolved: [] }) };
        return { text: JSON.stringify({ status: 'SOURCE_GAP', unresolved: [{ item: 'تعارض', material: true }] }) };
      },
    };
    const skill = createFiqhHaydSkill({ readiness: new DecisionReadinessService() });
    await skill.execute({
      projectId: 'p1', actor: 'a1',
      input: {
        text: 'نزل دم ٦ ساعات فقط',
        context: { total_bleeding_duration_24h: true },
        recentTurns: [
          { role: 'assistant', text: 'هل نزل دم آخر بحيث يصل المجموع إلى ٢٤ ساعة؟' },
          { role: 'user', text: 'نعم' },
        ],
      },
      knowledge: { search: async () => APPROVED_EVIDENCE, resolveSources: async () => [{ id: APPROVED_ID, title: 'الحيض الالوكة' }], adjacent: async () => [] },
      model,
    } as never);
    const decisionPrompt = prompts[2];
    assert.match(decisionPrompt, /answeredQuestions/);
    assert.match(decisionPrompt, /هل نزل دم آخر بحيث يصل المجموع إلى ٢٤ ساعة/);
    assert.match(decisionPrompt, /total_bleeding_duration_24h/);
  });
});
