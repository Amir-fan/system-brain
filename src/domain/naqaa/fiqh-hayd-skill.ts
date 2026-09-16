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
  type FiqhReasoningPlan,
  type FiqhSourceGap,
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
          trace: { issue: 'غير محدد', status: 'SOURCE_GAP', notes: ['approved_sources_missing'], requirementKeys: [] },
        };
      }
      const approvedIds = approved.map((s) => s.id);

      // ---- 3. knowledge need: bridge user language -> source language -------
      const planRes = await ctx.model.generateText({
        workload: WORKLOAD,
        message: `${PLANNER_SYSTEM}\n\nوصف الحالة (بالعامية):\n${caseText}\n\nحقائق معروفة: ${JSON.stringify(known)}`,
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
          trace: { issue, status: 'SOURCE_GAP', approvedSourceIds: approvedIds, notes: gaps.notes, requirementKeys: [] },
        };
      }

      // ---- 5. interpret source conditions against the case facts -----------
      const evidenceBlock = evidence
        .map((p) => `[${p.chunkId}] (${p.sourceTitle}) ${bounded(p.text, MAX_PASSAGE_CHARS)}`)
        .join('\n\n');
      const interpRes = await ctx.model.generateText({
        workload: WORKLOAD,
        message: `${INTERPRETER_SYSTEM}\n\nوصف الحالة (بالعامية):\n${caseText}\n\nحقائق معروفة: ${JSON.stringify(known)}\n\nالنصوص المُسترجَعة من المصدر المعتمد:\n${evidenceBlock}`,
      });
      const reasoning = parseJson<FiqhReasoningPlan>(interpRes.text);
      if (!reasoning || !Array.isArray(reasoning.requirements)) {
        gaps.present = true;
        gaps.notes.push('reasoning_output_unusable');
        return {
          status: 'SOURCE_GAP',
          issue,
          sourceGap: gaps,
          approvedSourceIds: approvedIds,
          evidenceChunkIds: evidence.map((p) => p.chunkId),
          requirementKeys: [],
          trace: { issue, status: 'SOURCE_GAP', approvedSourceIds: approvedIds, evidence: evidence.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId })), notes: gaps.notes, requirementKeys: [] },
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

      const status = readiness.status === 'READY_FOR_DECISION' ? 'READY_FOR_FIQH_DECISION' : 'NEEDS_INFORMATION';

      return {
        status,
        issue,
        interpretations: interpretations.map((i) => ({ observation: i.observation, candidateConcept: i.candidateConcept, supported: i.supported, citationIds: i.citations.map((c) => c.chunkId) })),
        requirementKeys: requirements.map((r) => r.key),
        sourceGap: gaps,
        approvedSourceIds: approvedIds,
        evidenceChunkIds: evidence.map((p) => p.chunkId),
        readiness,
        trace: {
          issue,
          status: gaps.present ? `${status}+SOURCE_GAP` : status,
          approvedSourceIds: approvedIds,
          evidence: evidence.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId, ...(p.headingContext ? { note: bounded(p.headingContext, 120) } : {}) })),
          requirementKeys: requirements.map((r) => r.key),
          notes: gaps.notes.slice(0, 6),
        },
      };
    },
  };
}
