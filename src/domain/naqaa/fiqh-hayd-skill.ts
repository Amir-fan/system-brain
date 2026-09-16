/**
 * @kip
 * @module naqaa
 * @layer domain
 * @owner naqaa
 * @feature K25
 * @purpose Shafi'i Fiqh Reasoning Skill V1 (menstruation issue family) — SLICE 1.
 *
 * SOURCE-GROUNDED, not a calculator and not a free-answering model:
 *   case -> candidate issue -> source-vocabulary knowledge need -> approved retrieval
 *   -> interpret source conditions/exceptions -> derive MATERIAL requirements
 *   -> K22 readiness -> K23 question -> answer -> re-evaluate
 *
 * The model only proposes (queries, interpretations, requirements). CODE validates:
 *   every material requirement must cite a retrieved passage, requirements already
 *   known (structured fact or stated in the case) are dropped, unsupported
 *   observation->concept mappings are preserved as SOURCE_GAP instead of guessed,
 *   and readiness is decided by the existing K22 evaluator.
 *
 * This slice does NOT produce the final ruling: it stops at READY_FOR_FIQH_DECISION.
 */

import type { SkillDefinition, SkillExecutionContext, SkillKnowledgePassage } from '../../core/skill/skill.ts';
import { SkillFailure } from '../../core/skill/skill.ts';
import type { DecisionRequirement, KnownContextItem, ReadinessResult } from '../../core/readiness/readiness.ts';
import {
  APPROVED_SOURCE_TITLES,
  FIQH_HAYD_SKILL_ID,
  FIQH_HAYD_SKILL_VERSION,
  MAX_ADJACENT_EXPANSIONS,
  MAX_CASE_CHARS,
  MAX_EVIDENCE_PASSAGES,
  MAX_PASSAGE_CHARS,
  MAX_QUERIES,
  MAX_REQUIREMENTS,
  type FiqhCaseInput,
  type FiqhEvidenceRef,
  type FiqhMaterialRequirement,
  type FiqhDecisionProposal,
  type FiqhReasoningPlan,
  type FiqhSourceGap,
  type FiqhSourceSupport,
  DECISION_MAX_OUTPUT_TOKENS,
  REASONING_MAX_OUTPUT_TOKENS,
  MADHHAB,
  type FiqhConfidence,
} from './fiqh-hayd-contracts.ts';

/** Existing K22 evaluator, injected (the skill owns its dynamic requirements). */
export interface FiqhHaydSkillDeps {
  readiness: { evaluate(input: { requirements: DecisionRequirement[]; known: KnownContextItem[] }): ReadinessResult };
}

const WORKLOAD = 'knowledge_answer';

// ---------------------------------------------------------------- prompt helpers

const PLANNER_SYSTEM = [
  'أنت مساعد لفهم سؤال امرأة عن أحكام الحيض في الفقه الشافعي.',
  'مهمتك فقط: (1) تحديد المسألة الفقهية المحتملة بجملة واحدة، (2) اقتراح عبارات بحث قصيرة',
  'بالمصطلح الذي تستخدمه كتب الفقه (لا تستخدم لغة العامية ولا نص السؤال حرفيًا).',
  'لا تُفتِ ولا تُصدر حكمًا ولا تختر مذهبًا آخر.',
  'أجب بـ JSON فقط بالشكل: {"issue": "...", "queries": ["...", "..."]}',
].join('\n');

const INTERPRETER_SYSTEM = [
  'أنت محلل يعمل على نصوص فقهية مُسترجَعة فقط، بمنهج الشافعية.',
  'قواعد صارمة:',
  '1) لا تُفتِ ولا تُصدر حكمًا نهائيًا.',
  '2) لا تخترع قاعدة أو شرطًا أو استثناءً غير موجود في النصوص المُعطاة.',
  '3) لكل معلومة "مادية" تقترحها يجب أن تُسند إلى مقاطع بأرقامها (citations).',
  '4) لا تُسند وصفًا إلى مفهوم فقهي إن لم يُعرِّفه النص صراحة؛ ضعه في unresolved.',
  '5) المتطلبات المادية يجب أن تكون حقائق يستطيع المستخدم ملاحظتها بنفسه، وبصياغة عربية بسيطة',
  '   (بمستوى يفهمه من عمره ١٢ سنة)، وبلا مصطلحات فقهية، وسؤال واحد لكل حاجة.',
  '6) لا تسأل عن حقيقة يعرفها السياق أو ذكرها المستخدم في وصفه للحالة (knownFromCase=true).',
  'أجب بـ JSON فقط بالشكل:',
  '{"interpretations":[{"observation":"...","candidateConcept":"...","supported":true,"citations":["chunkId"]}],',
  ' "requirements":[{"key":"snake_case","whyMaterial":"...","question":{"wording":"..."},',
  ' "interaction":{"type":"single_choice|yes_no|number|duration|date|free_text","options":["..."]},',
  ' "citations":["chunkId"],"knownFromCase":false}],',
  ' "unresolved":["..."]}',
].join('\n');

const DECISION_SYSTEM = [
  'أنت محلل يستنتج الحكم من نصوص فقهية مُسترجَعة فقط، على منهج الشافعية.',
  'قواعد صارمة لا يجوز خرقها:',
  '1) كل حكم يجب أن يكون مُسنَدًا إلى المقاطع المعطاة بأرقامها؛ لا تفتِ من معرفتك العامة.',
  '2) لا تخترع قاعدة أو شرطًا أو حدًّا غير موجود في المقاطع.',
  '3) لا تُحوّل وصفًا ذكره المستخدم إلى مفهوم فقهي إن لم يُعرّفه النص؛ ضعه في unresolved.',
  '4) إن لم تكفِ المقاطع لحسم الحكم: status=SOURCE_GAP (لا تخمّن).',
  '5) إن نقصت معلومة من المستخدم تمنع الحكم: status=NEEDS_INFORMATION مع سؤال واحد بسيط.',
  '5أ) كل سؤال يجب أن يحمل حاجة واحدة فقط؛ لا تجمع شرطين أو حاجتين في سؤال واحد.',
  '5ب) حقائق معروفة تأتي بقيمة مختصرة ومعها الأسئلة التي أجابت عنها؛ فسّر كل قيمة في ضوء سؤالها.',
  '5ج) إن تعارضت حقيقة معروفة مع وصف الحالة، لا تُصدر حكمًا: status=SOURCE_GAP بسبب صريح.',
  '6) إن قررت: كن مباشرًا وبسيطًا (يفهمه من عمره ١٢ سنة)، بلا مصطلحات زائدة.',
  'أجب بـ JSON فقط:',
  '{"status":"DECIDED|NEEDS_INFORMATION|SOURCE_GAP",',
  ' "category":"كلمة قصيرة مثل: حيض / ليس حيضًا / طهر",',
  ' "directAnswer":"جملة أو جملتان", "explanation":"سبب مختصر جدًا",',
  ' "confidence":"LOW|MEDIUM|HIGH", "sourceSupport":"SUPPORTED|PARTIAL|UNSUPPORTED",',
  ' "evidenceRefs":["chunkId"],',
  ' "observationMappings":[{"observation":"...","concept":"...","evidenceRefs":["chunkId"]}],',
  ' "unresolved":[{"item":"...","material":true,"reason":"..."}],',
  ' "needsInformation":{"key":"snake_case","whyMaterial":"...","question":{"wording":"..."},"interaction":{"type":"yes_no|single_choice|number|duration|date|free_text","options":["..."]},"evidenceRefs":["chunkId"]}}',
  'لا تُضف أي حقل آخر، ولا تكتب أي شيء خارج JSON.',
].join(String.fromCharCode(10));

/** Tolerant JSON extraction: models occasionally wrap JSON in prose or fences. */
function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function bounded(s: string, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const isKnown = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim() !== '[]';

// ---------------------------------------------------------------- skill factory

export function createFiqhHaydSkill(deps: FiqhHaydSkillDeps): SkillDefinition {
  return {
    id: FIQH_HAYD_SKILL_ID,
    version: FIQH_HAYD_SKILL_VERSION,
    description:
      "Shafi'i V1 source-grounded reasoning skill (menstruation): derives material information needs from approved source conditions; no final ruling in this slice.",
    requirements: { understanding: true, memory: false, knowledge: true, model: true },

    validateInput(input: unknown) {
      return input && typeof input === 'object' ? { ok: true } : { ok: false, message: 'input must be an object' };
    },

    validateOutput(output: unknown) {
      const o = output as { status?: unknown } | null;
      if (!o || typeof o !== 'object') return { ok: false, message: 'output must be an object' };
      if (!['NEEDS_INFORMATION', 'READY_FOR_FIQH_DECISION', 'SOURCE_GAP'].includes(String(o.status))) {
        return { ok: false, message: 'output.status must be a fiqh case status' };
      }
      return { ok: true };
    },

    async execute(ctx: SkillExecutionContext) {
      if (!ctx.knowledge) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'knowledge capability missing');
      if (!ctx.model) throw new SkillFailure('SKILL_INVALID_OUTPUT', 'model capability missing');

      const input = (ctx.input ?? {}) as FiqhCaseInput;
      const known = (input.context ?? {}) as Record<string, unknown>;
      const gaps: FiqhSourceGap = { present: false, observations: [], notes: [] };

      // ---- 0. follow-up on the latest grounded result (no new facts, no model call)
      // The conversation hands us its bounded session result only while it is still
      // valid; a material correction clears it before we ever see it.
      const stored = input.lastGroundedResult;
      const asked = strOf(input.text);
      if (stored && stored.skillId === FIQH_HAYD_SKILL_ID && asked.length <= 60) {
        const wantsSource = /مصدر|من وين|الدليل|المرجع|مرجعك|دليلك/.test(asked);
        const wantsWhy = /ليش|ليه|لماذا|السبب|سبب|وضح|وضّح|فسر|اشرح/.test(asked);
        if (wantsSource || wantsWhy) {
          const refs = (stored.evidenceRefs ?? []).slice(0, 6);
          const text = wantsSource
            ? `المصدر المعتمد: «${bounded(strOf(stored.sourceTitle) || 'المصدر المعتمد في المشروع', 160)}».` +
              (refs.length ? `\nالمقاطع المستشهد بها: ${refs.map((r) => r.slice(0, 8)).join('، ')}.` : '')
            : (bounded(strOf(stored.explanation) || strOf(stored.decision), 700) ||
               'الحكم مبني على المصدر المعتمد عندي.');
          return {
            status: stored.status === 'DECIDED' ? 'READY_FOR_FIQH_DECISION' : 'SOURCE_GAP',
            issue: 'متابعة على الحكم السابق',
            decision: {
              status: stored.status === 'DECIDED' ? 'DECIDED' : 'SOURCE_GAP',
              ...(stored.decision ? { category: stored.decision } : {}),
              sourceSupport: stored.status === 'DECIDED' ? 'SUPPORTED' : 'PARTIAL',
              evidenceRefs: refs,
            },
            requirementKeys: [],
            sourceGap: gaps,
            approvedSourceIds: [],
            evidenceChunkIds: refs,
            answer: {
              text,
              ...(stored.sourceTitle ? { sourceTitle: stored.sourceTitle } : {}),
              ...(refs.length ? { evidenceIds: refs } : {}),
              ...(stored.decision ? { label: stored.decision } : {}),
            },
            trace: {
              issue: 'متابعة على الحكم السابق',
              status: wantsSource ? 'FOLLOWUP_SOURCE' : 'FOLLOWUP_WHY',
              decisionStatus: stored.status,
              ...(stored.decision ? { decisionLabel: stored.decision } : {}),
              sourceSupport: stored.status === 'DECIDED' ? 'SUPPORTED' : 'PARTIAL',
              acceptedEvidenceRefs: refs,
              retrievedEvidenceIds: refs,
              requirementKeys: [],
              workload: `${WORKLOAD}:followup_answered_from_session_result`,
            },
          };
        }
      }

      // ---- 1. the case as the user described it (bounded) -------------------
      const caseText = bounded(
        [
          ...(input.recentTurns ?? []).filter((t) => t.role === 'user').map((t) => t.text),
          strOf(input.text),
        ].join('\n'),
        MAX_CASE_CHARS,
      );

      // ---- 2. approved source set (identity, not just role) -----------------
      const approved = await ctx.knowledge.resolveSources([...APPROVED_SOURCE_TITLES]);
      if (approved.length === 0) {
        // No approved source in this project => nothing can be grounded. Never guess.
        gaps.present = true;
        gaps.notes.push('approved_sources_missing');
        return {
          status: 'SOURCE_GAP',
          sourceGap: gaps,
          approvedSourceIds: [],
          evidenceChunkIds: [],
          answer: { text: 'المصدر المعتمد عندي ما يكفي لحسم هذه الصورة بدقة.' },
          trace: { issue: 'غير محدد', status: 'SOURCE_GAP', notes: ['approved_sources_missing'], requirementKeys: [], retrievedEvidenceIds: [], acceptedEvidenceRefs: [], workload: WORKLOAD, sourceSupport: 'UNSUPPORTED' },
        };
      }
      const approvedIds = approved.map((s) => s.id);

      // ---- 3. knowledge need: bridge user language -> source language -------
      const planRes = await ctx.model.generateText({
        workload: WORKLOAD,
        message: `${PLANNER_SYSTEM}\n\nوصف الحالة (بالعامية):\n${caseText}\n\nحقائق معروفة: ${JSON.stringify(known)}`,
        maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
      });
      const plan = parseJson<{ issue?: string; queries?: unknown[] }>(planRes.text) ?? {};
      const issue = bounded(strOf(plan.issue), 300) || 'مسألة غير محددة';
      const queries = (Array.isArray(plan.queries) ? plan.queries : []).map(strOf).map((q) => bounded(q, 120)).filter(Boolean).slice(0, MAX_QUERIES);
      if (queries.length === 0) gaps.notes.push('no_source_queries_proposed');

      // ---- 4. retrieve ONLY from the approved sources -----------------------
      const passages = new Map<string, SkillKnowledgePassage>();
      for (const q of queries) {
        const hits = await ctx.knowledge.search({ query: q, topK: 3, sourceIds: approvedIds });
        for (const h of hits) if (h.sourceId && approvedIds.includes(h.sourceId)) passages.set(h.chunkId, h);
      }
      // Bounded adjacency for the strongest passages (source statements span chunks).
      const top = [...passages.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, MAX_ADJACENT_EXPANSIONS);
      for (const p of top) {
        const neighbours = await ctx.knowledge.adjacent(p.chunkId, 1);
        for (const n of neighbours) if (!passages.has(n.chunkId) && approvedIds.includes(n.sourceId)) passages.set(n.chunkId, n);
      }
      const evidence = [...passages.values()].slice(0, MAX_EVIDENCE_PASSAGES);

      if (evidence.length === 0) {
        gaps.present = true;
        gaps.notes.push('no_approved_source_evidence_retrieved');
        return {
          status: 'SOURCE_GAP',
          issue,
          sourceGap: gaps,
          approvedSourceIds: approvedIds,
          evidenceChunkIds: [],
          answer: { text: 'المصدر المعتمد عندي ما يكفي لحسم هذه الصورة بدقة.' },
          trace: { issue, status: 'SOURCE_GAP', approvedSourceIds: approvedIds, notes: gaps.notes, requirementKeys: [], retrievedEvidenceIds: [], acceptedEvidenceRefs: [], workload: WORKLOAD, sourceSupport: 'UNSUPPORTED' },
        };
      }

      // ---- 5. interpret source conditions against the case facts -----------
      const evidenceBlock = evidence
        .map((p) => `[${p.chunkId}] (${p.sourceTitle}) ${bounded(p.text, MAX_PASSAGE_CHARS)}`)
        .join('\n\n');
      const interpRes = await ctx.model.generateText({
        workload: WORKLOAD,
        message: `${INTERPRETER_SYSTEM}\n\nوصف الحالة (بالعامية):\n${caseText}\n\nحقائق معروفة: ${JSON.stringify(known)}\n\nالنصوص المُسترجَعة من المصدر المعتمد:\n${evidenceBlock}`,
        maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
      });
      const reasoning = parseJson<FiqhReasoningPlan>(interpRes.text);
      if (!reasoning || !Array.isArray(reasoning.requirements)) {
        gaps.present = true;
        // Bounded, auditable failure note (length + truncation flag only: never the text).
        const raw = interpRes.text ?? '';
        gaps.notes.push(`reasoning_output_unusable:len=${raw.length}:closed=${raw.trimEnd().endsWith('}')}`);
        return {
          status: 'SOURCE_GAP',
          issue,
          sourceGap: gaps,
          approvedSourceIds: approvedIds,
          evidenceChunkIds: evidence.map((p) => p.chunkId),
          requirementKeys: [],
          answer: { text: 'المصدر المعتمد عندي ما يكفي لحسم هذه الصورة بدقة.' },
          trace: { issue, status: 'SOURCE_GAP', approvedSourceIds: approvedIds, evidence: evidence.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId })), notes: gaps.notes, requirementKeys: [], retrievedEvidenceIds: evidence.map((p) => p.chunkId), acceptedEvidenceRefs: [], workload: WORKLOAD, sourceSupport: 'UNSUPPORTED' },
        };
      }

      // ---- 6. deterministic validation (this is what makes it source-grounded)
      const validIds = new Set(evidence.map((p) => p.chunkId));
      const byId = new Map(evidence.map((p) => [p.chunkId, p]));
      const citeRefs = (ids: unknown): FiqhEvidenceRef[] =>
        (Array.isArray(ids) ? ids : [])
          .map(strOf)
          .filter((id) => validIds.has(id))
          .slice(0, 4)
          .map((id) => ({ chunkId: id, sourceId: byId.get(id)!.sourceId, quote: bounded(byId.get(id)!.text, 240) }));

      const interpretations = (Array.isArray(reasoning.interpretations) ? reasoning.interpretations : [])
        .slice(0, MAX_REQUIREMENTS)
        .map((i) => ({ observation: bounded(strOf(i.observation), 200), candidateConcept: bounded(strOf(i.candidateConcept), 160), citations: citeRefs(i.citations) }))
        .map((i) => ({ ...i, supported: i.citations.length > 0 }))
        .filter((i) => i.observation.length > 0);

      const requirements: FiqhMaterialRequirement[] = [];
      const dropped: string[] = [];
      for (const r of (Array.isArray(reasoning.requirements) ? reasoning.requirements : [])) {
        const key = bounded(strOf(r?.key), 64);
        const wording = bounded(strOf(r?.question?.wording), 240);
        const citations = citeRefs(r?.citations);
        if (!key || !wording) continue;
        // (a) source grounding: an uncited requirement is NOT material evidence, it is a guess.
        if (citations.length === 0) {
          dropped.push(`uncited_requirement:${key}`);
          continue;
        }
        // (b) never re-ask what is already known (structured fact or stated in the case).
        if (isKnown(known[key]) || r?.knownFromCase === true) {
          dropped.push(`already_known:${key}`);
          continue;
        }
        if (requirements.some((x) => x.key === key)) continue;
        const type = bounded(strOf(r?.interaction?.type), 24) || 'free_text';
        const options = Array.isArray(r?.interaction?.options) ? r.interaction.options.map(strOf).filter(Boolean).slice(0, 6) : [];
        requirements.push({
          key,
          whyMaterial: bounded(strOf(r?.whyMaterial), 240),
          question: { wording },
          interaction: { type, ...(options.length ? { options } : {}), ...(typeof r?.interaction?.allowOther === 'boolean' ? { allowOther: r.interaction.allowOther } : {}) },
          citations,
        });
        if (requirements.length >= MAX_REQUIREMENTS) break;
      }

      // (c) unsupported observation -> concept mappings are preserved, never guessed.
      const unresolved = (Array.isArray(reasoning.unresolved) ? reasoning.unresolved : []).map((u) => bounded(strOf(u), 200)).filter(Boolean);
      const unsupportedObservations = interpretations.filter((i) => !i.supported).map((i) => i.observation);
      if (unsupportedObservations.length > 0 || unresolved.length > 0) {
        gaps.present = true;
        gaps.observations = [...new Set([...unsupportedObservations, ...unresolved])].slice(0, 6);
        gaps.notes.push('observation_not_defined_by_approved_source');
      }
      if (dropped.length > 0) gaps.notes.push(...dropped.slice(0, 6));

      // ---- 7. readiness (existing K22 evaluator; dynamic requirements) ------
      const decisionRequirements: DecisionRequirement[] = requirements.map((r) => ({
        key: r.key,
        description: r.whyMaterial || r.question.wording,
        material: true, // every validated, cited, still-unknown need is material by construction
        question: { key: r.key, wording: r.question.wording },
        interaction: r.interaction,
      }));
      const knownItems: KnownContextItem[] = Object.entries(known)
        .filter(([, v]) => isKnown(v))
        .map(([key, value]) => ({ key, value, source: 'conversation' as const }));
      const readiness = deps.readiness.evaluate({ requirements: decisionRequirements, known: knownItems });

      const baseTrace = (st: string, extra: Record<string, unknown> = {}) => ({
        issue,
        status: st,
        approvedSourceIds: approvedIds,
        evidence: evidence.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId, ...(p.headingContext ? { note: bounded(p.headingContext, 120) } : {}) })),
        requirementKeys: requirements.map((r) => r.key),
        retrievedEvidenceIds: evidence.map((p) => p.chunkId),
        gapKeys: gaps.observations.slice(0, 8),
        notes: gaps.notes.slice(0, 6),
        ...extra,
      });

      // Not decision-ready yet: the material questions ARE the answer.
      if (readiness.status !== 'READY_FOR_DECISION') {
        return {
          status: 'NEEDS_INFORMATION',
          issue,
          interpretations: interpretations.map((i) => ({ observation: i.observation, candidateConcept: i.candidateConcept, supported: i.supported, citationIds: i.citations.map((c) => c.chunkId) })),
          requirementKeys: requirements.map((r) => r.key),
          sourceGap: gaps,
          approvedSourceIds: approvedIds,
          evidenceChunkIds: evidence.map((p) => p.chunkId),
          readiness,
          trace: baseTrace(gaps.present ? 'NEEDS_INFORMATION+SOURCE_GAP' : 'NEEDS_INFORMATION'),
        };
      }

      // ---- 8. SOURCE-GROUNDED DECISION: the model proposes, CODE validates -----
      // A bare `true` is only meaningful together with the question it answered, so the
      // bounded questions that produced the stored facts travel with them.
      const askedQuestions = (input.recentTurns ?? [])
        .filter((t) => t.role === 'assistant')
        .map((t) => bounded(strOf(t.text), 200))
        .slice(-3);
      const decisionInput = {
        madhhab: MADHHAB,
        issue,
        caseText,
        knownFacts: known,
        /** The questions the user answered to produce knownFacts (bounded). */
        answeredQuestions: askedQuestions,
        observations: interpretations.map((i) => ({ observation: i.observation, candidateConcept: i.candidateConcept, supportedBySource: i.supported })),
        sourceGaps: gaps.observations,
        approvedSourceTitles: [...APPROVED_SOURCE_TITLES].join('، '),
        evidence: evidence.map((p) => `[${p.chunkId}] ${bounded(p.text, MAX_PASSAGE_CHARS)}`).join('\n\n'),
      };
      const decisionRes = await ctx.model.generateText({
        workload: WORKLOAD,
        message: `${DECISION_SYSTEM}\n\nالحالة والمقاطع:\n${JSON.stringify(decisionInput)}`,
        // A bounded structured ruling: enough room for the JSON contract, and no
        // provider-side reservation of the model's full output capacity.
        maxOutputTokens: DECISION_MAX_OUTPUT_TOKENS,
      });
      const proposal = parseJson<FiqhDecisionProposal>(decisionRes.text);
      const verdict = validateDecision({ proposal, evidence, gapObservations: gaps.observations });
      const modelTag = [decisionRes.provider, decisionRes.model].filter(Boolean).join('/') || undefined;

      if (verdict.kind === 'NEEDS_INFORMATION' && verdict.requirement) {
        // The reasoning layer found one more materially necessary fact: route it through
        // the SAME dynamic-requirement path (no second question engine, no new ordering).
        const merged = [...requirements, verdict.requirement];
        const mergedReadiness = deps.readiness.evaluate({
          requirements: merged.map((r) => ({
            key: r.key,
            description: r.whyMaterial || r.question.wording,
            material: true,
            question: { key: r.key, wording: r.question.wording },
            interaction: r.interaction,
          })),
          known: knownItems,
        });
        return {
          status: 'NEEDS_INFORMATION',
          issue,
          interpretations: interpretations.map((i) => ({ observation: i.observation, candidateConcept: i.candidateConcept, supported: i.supported, citationIds: i.citations.map((c) => c.chunkId) })),
          requirementKeys: merged.map((r) => r.key),
          sourceGap: gaps,
          approvedSourceIds: approvedIds,
          evidenceChunkIds: evidence.map((p) => p.chunkId),
          readiness: mergedReadiness,
          trace: baseTrace('NEEDS_INFORMATION', { decisionStatus: 'NEEDS_INFORMATION', workload: WORKLOAD, ...(modelTag ? { model: modelTag } : {}) }),
        };
      }

      if (verdict.kind === 'DECIDED' && verdict.directAnswer) {
        return {
          status: 'READY_FOR_FIQH_DECISION',
          issue,
          interpretations: interpretations.map((i) => ({ observation: i.observation, candidateConcept: i.candidateConcept, supported: i.supported, citationIds: i.citations.map((c) => c.chunkId) })),
          decision: {
            status: 'DECIDED',
            category: verdict.category,
            confidence: verdict.confidence,
            sourceSupport: 'SUPPORTED',
            evidenceRefs: verdict.refs.map((r) => r.chunkId),
            observationMappings: verdict.mappings,
            unresolved: verdict.unresolved,
          },
          requirementKeys: [],
          sourceGap: gaps,
          approvedSourceIds: approvedIds,
          evidenceChunkIds: evidence.map((p) => p.chunkId),
          readiness,
          answer: {
            text: [verdict.directAnswer, verdict.explanation].filter(Boolean).join('\n'),
            ...(evidence[0]?.sourceTitle ? { sourceTitle: evidence[0].sourceTitle } : {}),
            evidenceIds: verdict.refs.map((r) => r.chunkId),
            ...(verdict.category ? { label: verdict.category } : {}),
          },
          trace: baseTrace(gaps.present ? 'DECIDED+UNRESOLVED_NOTE' : 'DECIDED', {
            decisionStatus: 'DECIDED',
            ...(verdict.category ? { decisionLabel: verdict.category } : {}),
            confidence: verdict.confidence,
            sourceSupport: 'SUPPORTED',
            acceptedEvidenceRefs: verdict.refs.map((r) => r.chunkId),
            ...(verdict.codes.length ? { notes: verdict.codes.slice(0, 6) } : {}),
            workload: WORKLOAD,
            ...(modelTag ? { model: modelTag } : {}),
          }),
        };
      }

      // No ruling: the approved source (or the user's facts) cannot support one.
      const sourceSide = verdict.codes.some((c) => /^(source_|mapping_|decision_refs|decision_source|decision_with_material|unaccounted_|model_reported_source_gap)/.test(c));
      const gapText = sourceSide
        ? 'المصدر المعتمد عندي ما يكفي لحسم هذه الصورة بدقة.'
        : 'أحتاج معلومة أوضح قبل ما أحدد الحكم.';
      const gapDetail = verdict.unresolvedMaterial.length
        ? `\nالنقطة اللي تحتاج توضيح: ${verdict.unresolvedMaterial.slice(0, 3).join('، ')}.`
        : '';
      return {
        status: 'SOURCE_GAP',
        issue,
          interpretations: interpretations.map((i) => ({ observation: i.observation, candidateConcept: i.candidateConcept, supported: i.supported, citationIds: i.citations.map((c) => c.chunkId) })),
        decision: {
          status: 'SOURCE_GAP',
          sourceSupport: verdict.sourceSupport,
          evidenceRefs: verdict.refs.map((r) => r.chunkId),
          unresolved: verdict.unresolved,
        },
        requirementKeys: [],
        sourceGap: gaps,
        approvedSourceIds: approvedIds,
        evidenceChunkIds: evidence.map((p) => p.chunkId),
        readiness,
        answer: {
          text: `${gapText}${gapDetail}`,
          ...(evidence[0]?.sourceTitle ? { sourceTitle: evidence[0].sourceTitle } : {}),
          ...(verdict.refs.length ? { evidenceIds: verdict.refs.map((r) => r.chunkId) } : {}),
        },
        trace: baseTrace('SOURCE_GAP', {
          decisionStatus: 'SOURCE_GAP',
          sourceSupport: verdict.sourceSupport,
          ...(verdict.refs.length ? { acceptedEvidenceRefs: verdict.refs.map((r) => r.chunkId) } : {}),
          ...(verdict.unresolvedMaterial.length ? { gapKeys: verdict.unresolvedMaterial.slice(0, 8) } : {}),
          notes: verdict.codes.slice(0, 6),
          workload: WORKLOAD,
          ...(modelTag ? { model: modelTag } : {}),
        }),
      };
    },
  };
}

// ---------------------------------------------------------------- decision guard
//
// The model PROPOSES; this code decides whether the proposal may reach the user.
// Fail-closed by construction: every doubt yields SOURCE_GAP (never a ruling).

interface DecisionVerdictBase {
  codes: string[];
  refs: FiqhEvidenceRef[];
  unresolved: Array<{ item: string; material: boolean; reason?: string }>;
  unresolvedMaterial: string[];
  sourceSupport: FiqhSourceSupport;
}

type DecisionVerdict =
  | (DecisionVerdictBase & { kind: 'DECIDED'; directAnswer: string; explanation?: string; category?: string; confidence: FiqhConfidence; mappings: Array<{ observation: string; concept: string; evidenceRefs: string[] }> })
  | (DecisionVerdictBase & { kind: 'NEEDS_INFORMATION'; requirement: FiqhMaterialRequirement })
  | (DecisionVerdictBase & { kind: 'SOURCE_GAP' });

export function validateDecision(args: {
  proposal: FiqhDecisionProposal | null;
  evidence: SkillKnowledgePassage[];
  /** Observations the approved source does not define (from the interpretation step). */
  gapObservations: string[];
}): DecisionVerdict {
  const { evidence, gapObservations } = args;
  const valid = new Map(evidence.map((e) => [e.chunkId, e]));
  const mkRefs = (ids: unknown): FiqhEvidenceRef[] =>
    (Array.isArray(ids) ? ids : [])
      .map(strOf)
      .filter((id) => valid.has(id))
      .slice(0, 4)
      .map((id) => ({ chunkId: id, sourceId: valid.get(id)!.sourceId, quote: bounded(valid.get(id)!.text, 240) }));

  const p = args.proposal && typeof args.proposal === 'object' ? args.proposal : null;
  if (!p) return { kind: 'SOURCE_GAP', codes: ['decision_output_unusable'], refs: [], unresolved: [], unresolvedMaterial: [], sourceSupport: 'UNSUPPORTED' };
  if (!['DECIDED', 'NEEDS_INFORMATION', 'SOURCE_GAP'].includes(strOf(p.status))) {
    return { kind: 'SOURCE_GAP', codes: ['decision_status_invalid'], refs: [], unresolved: [], unresolvedMaterial: [], sourceSupport: 'UNSUPPORTED' };
  }

  const unresolved = (Array.isArray(p.unresolved) ? p.unresolved : [])
    .slice(0, 8)
    .map((u) => ({ item: bounded(strOf(u?.item), 200), material: u?.material === true, ...(strOf(u?.reason) ? { reason: bounded(strOf(u.reason), 200) } : {}) }))
    .filter((u) => u.item.length > 0);
  const unresolvedMaterial = unresolved.filter((u) => u.material).map((u) => u.item);
  const sourceSupport: FiqhSourceSupport = ['SUPPORTED', 'PARTIAL', 'UNSUPPORTED'].includes(strOf(p.sourceSupport))
    ? (strOf(p.sourceSupport) as FiqhSourceSupport)
    : 'UNSUPPORTED';

  if (strOf(p.status) === 'SOURCE_GAP') {
    return {
      kind: 'SOURCE_GAP',
      codes: ['model_reported_source_gap', ...unresolvedMaterial.map((i) => `source_gap:${bounded(i, 120)}`)],
      refs: mkRefs(p.evidenceRefs), unresolved, unresolvedMaterial, sourceSupport,
    };
  }

  if (strOf(p.status) === 'NEEDS_INFORMATION') {
    const n = p.needsInformation;
    const key = bounded(strOf(n?.key), 64);
    const wording = bounded(strOf(n?.question?.wording), 240);
    const refs = mkRefs(n?.evidenceRefs);
    if (!key || !wording || refs.length === 0) {
      return { kind: 'SOURCE_GAP', codes: ['needs_information_unusable'], refs, unresolved, unresolvedMaterial, sourceSupport };
    }
    const type = bounded(strOf(n?.interaction?.type), 24) || 'free_text';
    const options = Array.isArray(n?.interaction?.options) ? n.interaction.options.map(strOf).filter(Boolean).slice(0, 6) : [];
    return {
      kind: 'NEEDS_INFORMATION',
      requirement: {
        key,
        whyMaterial: bounded(strOf(n?.whyMaterial), 240),
        question: { wording },
        interaction: { type, ...(options.length ? { options } : {}), ...(typeof n?.interaction?.allowOther === 'boolean' ? { allowOther: n.interaction.allowOther } : {}) },
        citations: refs,
      },
      codes: ['model_requested_information'], refs, unresolved, unresolvedMaterial, sourceSupport,
    };
  }

  // ---- DECIDED: every guard must pass, otherwise no ruling is returned -----
  const codes: string[] = [];
  const directAnswer = bounded(strOf(p.directAnswer), 400);
  if (!directAnswer) return { kind: 'SOURCE_GAP', codes: ['decision_empty_answer'], refs: [], unresolved, unresolvedMaterial, sourceSupport };
  const refs = mkRefs(p.evidenceRefs);
  if (refs.length === 0) return { kind: 'SOURCE_GAP', codes: ['decision_refs_missing_or_not_retrieved'], refs: [], unresolved, unresolvedMaterial, sourceSupport };
  if (sourceSupport !== 'SUPPORTED') codes.push('decision_source_support_not_supported');
  if (unresolvedMaterial.length > 0) codes.push('decision_with_material_source_gap');
  const mappings = (Array.isArray(p.observationMappings) ? p.observationMappings : [])
    .slice(0, 6)
    .map((m) => ({ observation: bounded(strOf(m?.observation), 200), concept: bounded(strOf(m?.concept), 160), evidenceRefs: mkRefs(m?.evidenceRefs).map((r) => r.chunkId) }))
    .filter((m) => m.observation.length > 0 && m.concept.length > 0);
  if (mappings.some((m) => m.evidenceRefs.length === 0)) codes.push('mapping_without_source_support');
  // Slice 1's boundary: a user observation the source does not define may not be
  // silently classified. It must be either mapped WITH source support or explicitly
  // declared non-material.
  for (const obs of gapObservations) {
    const head = obs.slice(0, 18);
    const mapped = mappings.some((m) => m.evidenceRefs.length > 0 && (m.observation.includes(head) || obs.includes(m.observation.slice(0, 18))));
    const declaredNonMaterial = unresolved.some((u) => !u.material);
    if (!mapped && !declaredNonMaterial) { codes.push('unaccounted_unsupported_observation'); break; }
  }
  if (codes.length > 0) return { kind: 'SOURCE_GAP', codes, refs, unresolved, unresolvedMaterial, sourceSupport };

  const confidence: FiqhConfidence = ['LOW', 'MEDIUM', 'HIGH'].includes(strOf(p.confidence)) ? (strOf(p.confidence) as FiqhConfidence) : 'LOW';
  return {
    kind: 'DECIDED',
    directAnswer,
    ...(strOf(p.explanation) ? { explanation: bounded(strOf(p.explanation), 400) } : {}),
    ...(strOf(p.category) ? { category: bounded(strOf(p.category), 60) } : {}),
    confidence, refs, mappings, codes, unresolved, unresolvedMaterial, sourceSupport,
  };
}
