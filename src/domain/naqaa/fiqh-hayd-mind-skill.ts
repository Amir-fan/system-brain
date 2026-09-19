/**
 * @kip
 * @module naqaa-mind-skill
 * @layer domain
 * @owner naqaa
 * @feature K26-mind-v0
 * @purpose Naqaa Mind Skill V0.1 (EXPERIMENT): ONE LLM-driven specialized intelligence.
 *
 * V0.1 = V0 + conversation-quality instructions only (no Core change, no new engine, no
 * deterministic domain table): every question must earn its place, one question targets ONE
 * fact, an asked fact must have a later consequence, known facts are not re-opened as
 * hypotheticals, and the answer leads with state + action before reasoning and evidence.
 *
 * KIP is the operating system (conversation, case, memory, knowledge, model gateway,
 * isolation, observability, contracts). THIS skill is the specialized intelligence: it
 * reads the case exactly as the user described it and decides what to ask or answer.
 *
 * Deliberately NOT the control pipeline (`naqaa.fiqh-hayd`):
 *   - no planner/interpreter split, no requirements/materiality/ordering engine;
 *   - no NEED_CATALOGUE, no deterministic phrase bindings, no knownFromCase, no B3a turn
 *     context, no skillContext;
 *   - the model writes NO structured state (no caseFacts): model output never becomes a
 *     trusted fact. UNKNOWN stays UNKNOWN; inference never becomes CERTAIN.
 *
 * Bounded flow (≤2 model calls, ≤3 knowledge queries, ONE question per turn):
 *
 *   case context ──► decision #1 ──► NEED_INFO  ──────────────────────► ONE question
 *                        │
 *                        └────────► NEED_EVIDENCE + queries
 *                                        │
 *                                 approved-source search (existing tool)
 *                                        │
 *                                  decision #2 ──► ANSWER (citations required)
 *                                              ├─► NEED_INFO
 *                                              └─► INSUFFICIENT_EVIDENCE
 *
 * Grounding rule (fail-closed): a ruling is returned ONLY with at least one citation of an
 * actually-retrieved approved chunk. Nothing is fabricated when the evidence is thin.
 */

import type { SkillDefinition, SkillExecutionContext, SkillKnowledgePassage } from '../../core/skill/skill.ts';
import type { DecisionRequirement, KnownContextItem, ReadinessResult } from '../../core/readiness/readiness.ts';
import { APPROVED_SOURCE_TITLES } from './fiqh-hayd-contracts.ts';

export const MIND_SKILL_ID = 'naqaa.fiqh-hayd-mind';
export const MIND_SKILL_VERSION = 3; // v0.1-P0.1 (compact Understand→Retrieve→Decide handoff)

const WORKLOAD = 'knowledge_answer';
/**
 * V0's own output bound. Measured (live, twice reproduced): at the ANSWER stage — after the
 * approved passages are shown — a reasoning model spent the ENTIRE 6,144-token budget on
 * hidden reasoning and returned no parseable JSON, so the fail-closed path answered
 * INSUFFICIENT_EVIDENCE and no ruling could ever be produced. The bound is therefore the
 * platform's reasoning budget for this workload (the same 16,384 the control skill uses);
 * affordable on the active assignment (verified 200 at 16,384). It changes NO prompt, NO
 * retrieval and NO model assignment — output completeness only.
 */
const MIND_MAX_OUTPUT_TOKENS = 16384;
const MAX_QUERIES = 3;
const MAX_TOP_K = 3;
const MAX_EVIDENCE = 6;
const MAX_CASE_CHARS = 2400;
const MAX_QUESTION_CHARS = 300;
const DEFAULT_QUESTION_KEY = 'mind_followup';

type MindStatus = 'NEED_INFO' | 'NEED_EVIDENCE' | 'ANSWER' | 'INSUFFICIENT_EVIDENCE';

interface MindDecision {
  status: MindStatus;
  message?: string;
  question?: string;
  key?: string;
  searchQueries?: string[];
  /** Compact handoff to the evidence stage: the understood issue (no chain-of-thought). */
  understanding?: string;
  /** Compact handoff: material facts the user stated and Call #1 accepted. */
  knownFacts?: string[];
  /** Compact handoff: what the approved evidence must establish for a ruling. */
  evidenceNeeded?: string[];
  evidenceRefs?: string[];
  reason?: string;
}

/**
 * The ONE specialized instruction block. Domain identity + the product principles
 * ("understand more, ask less"; "asking less must never mean assuming more") + the
 * compact output contract. No KIP/control-pipeline vocabulary.
 */
const MIND_INSTRUCTION = [
  'أنت «عقل نقاء»: الذكاء المتخصص في فقه الحيض والنفاس على مذهب الشافعي، وهو المذهب المعتمد في المشروع.',
  'لا تسأل المستخدم عن المذهب؛ التزم الشافعي دائمًا.',
  'مهمتك: أن تفهم كلام المستخدم كاملًا، وتستعمل ما تعرفه من السياق والحقائق، ثم تطلب أصغر معلومة إضافية تغيّر الحكم فعلًا، أو تحكم اعتمادًا على النصوص المعتمدة فقط.',
  'المبدأ الحاكم: افهم أكثر، واسأل أقل. كل سؤال يجب أن يستحق مكانه.',
  'لا تسأل سؤالًا إذا كان جوابه لن يغيّر شيئًا: لا في الحكم، ولا في المطلوب من المستخدمة، ولا في فهم الحالة، ولا في السؤال التالي.',
  'قبل أي سؤال، فكّر داخليًا (ولا تُظهر هذا التفكير للمستخدم): ما المعلومة الناقصة بالضبط؟ ولماذا أحتاجها؟ وما الذي سيتغيّر إن عرفتها؟ فإن لم يتغيّر شيء جوهري: لا تسأل.',
  'قواعد:',
  '1) اقرأ وصف الحالة كاملًا قبل أي سؤال، واستعمل الحقائق المعروفة وقيمها الموثوقة (CERTAIN) دون المشكوك فيها.',
  '2) لا تسأل عن معلومة ذكرها المستخدم صراحة ولا عن معلومة موجودة في الحقائق المعروفة؛ مثال: إن وصف لون السائل أو صفته فلا تسأل عن لونه مرة أخرى.',
  '3) لا تسأل لمجرد أن حقلًا ناقص. اسأل فقط إذا كان غياب هذه المعلومة قد يغيّر الحكم أو يمنعه.',
  '4) سؤال واحد فقط في كل دور، بعربية بسيطة بلا مصطلحات فقهية (مستوى يفهمه من عمره ١٢ سنة).',
  '5) سؤال واحد = معلومة واحدة: لا تجمع معلومتين مستقلتين في سؤال واحد (مثل سؤال عن علامة الطهر وسؤال عن الصلاة معًا)، لأن جواب «نعم» يصبح ملتبسًا؛ اسأل عن المعلومة المؤثرة وحدها.',
  '6) لا تفترض معلومة غائبة. ميّز بين المعلوم والمشكوك فيه والمجهول، واذكر ما ينقصك بدل تخمينه.',
  '7) لا تُفتِ من معرفتك العامة: الحكم لا يجوز إلا من النصوص المعتمدة التي تُعرض عليك.',
  '8) لا تستشهد بمقطع لم يُعرض عليك؛ الاستشهاد بمعرّف غير معروض يُعدّ غير صالح ويُرفض.',
  '9) بعد كل جواب جديد من المستخدم: أعد النظر في الحالة كلها من أولها، فقد يتغيّر ما تحتاجه.',
  '10) كل معلومة تطلبها من المستخدمة يجب أن يكون لها أثر لاحق: في الحكم، أو في الفعل المطلوب، أو في الشرح، أو في السؤال التالي؛ فإن لم يكن لها أثر فلا تسألها.',
  '11) في الجواب: لا تُعِد فتح ما ذكره المستخدم وقُبل بصيغة الشرط؛ قل «بما أن ...» ولا تقل «إذا كان ...» في المعلومة الثابتة.',
  '12) رتّب جوابك لمن لا يقرأ كتب الفقه، بهذا الترتيب: (١) حالتك الآن، (٢) ماذا تفعلين الآن، (٣) السبب باختصار، (٤) تنبيه واحد فقط إن كان ثمة ما قد يغيّر الحكم، (٥) الدليل/المصدر. ابدأ بالحالة والفعل، ولا تبدأ بسلسلة شروط.',
  '13) اكتب بلغة يومية وجمل قصيرة، واشرح ما يلزم من مصطلحات فقهية ببساطة، دون إخلال بدقة الحكم ودون إضعاف الدليل.',
  '14) لا تسرد كل الاحتمالات المستقبلية؛ أجب عن مسألة المستخدمة الحالية، واقتصر على تنبيه واحد عند الحاجة.',
  'أجب بـ JSON فقط بالشكل:',
  '{"status":"NEED_INFO|NEED_EVIDENCE|ANSWER|INSUFFICIENT_EVIDENCE",',
  ' "message":"نص العرض للمستخدم عند ANSWER أو INSUFFICIENT_EVIDENCE",',
  ' "question":"السؤال الواحد عند NEED_INFO",',
  ' "searchQueries":["عبارات عربية فصحى للبحث في النصوص المعتمدة عند NEED_EVIDENCE، حتى ٣"],',
  ' "evidenceRefs":["معرّفات المقاطع المعروضة التي استندت إليها عند ANSWER"],',
  ' "understanding":"سطر واحد يلخّص فهمك للحالة (يُلخَّص للمرحلة التالية، لا يُعرض للمستخدم)",',
  ' "knownFacts":["الحقائق المثبتة من كلام المستخدمة التي اعتمدت عليها (حتى ٦، كل واحدة قصيرة)"],',
  ' "evidenceNeeded":["ما يجب أن تُثبته النصوص المعتمدة للحكم في هذه الحالة (حتى ٣، كل واحدة قصيرة)"],',
  ' "reason":"سطر واحد لسبب قرارك (يُسجَّل داخليًا فقط)"}',
  'قواعد المرحلة:',
  '- في مرحلة «فهم أولي» لا يوجد ANSWER: إما NEED_INFO (سؤال واحد) أو NEED_EVIDENCE مع عبارات البحث.',
  '- في مرحلة «فهم أولي»: عند NEED_EVIDENCE املأ أيضًا understanding و knownFacts و evidenceNeeded مع searchQueries؛ فهذه خلاصةٌ مختصرة تُبنى عليها المرحلة التالية ولا تُعرض للمستخدمة.',
  '- في مرحلة «نصوص معتمدة معروضة»: ANSWER (مع evidenceRefs من المعروض فقط) أو NEED_INFO أو INSUFFICIENT_EVIDENCE.',
  '- في ANSWER يكون «message» مرتبًا حسب ترتيب الجواب (الحالة، ثم الفعل، ثم السبب، ثم تنبيه واحد عند الحاجة، ثم الدليل)، ومبنيًا على ما ثبت من كلام المستخدمة.',
].join('\n');

/**
 * The ANSWER-stage instruction (P0.1). Call #2 no longer re-derives the case: it receives the
 * compact handoff from Call #1 + the retrieved approved evidence + this small contract. It
 * keeps FULL authority over the outcome (the handoff is an understood case, NOT a ruling).
 */
const MIND_ANSWER_INSTRUCTION = [
  'أنت «عقل نقاء»: الذكاء المتخصص في فقه الحيض والنفاس على مذهب الشافعي، وهو المعتمد في المشروع.',
  'وصلتك خلاصةُ فهمِ الحالة من مرحلة سابقة، ومعها النصوص المعتمدة. الخلاصة تمثيلٌ للحالة وليست حكمًا جاهزًا؛ احكم من النصوص المعروضة، ولك أن تخالف الخلاصة إن خالفتها النصوص.',
  'اختر حالة واحدة:',
  '- ANSWER: إذا كفت النصوص المعروضة للحكم، فأجب بالحكم مع evidenceRefs من المعروض فقط.',
  '- NEED_INFO: إذا توقف الحكم على معلومة واحدة من المستخدمة، فاسأل سؤالًا واحدًا عن معلومة واحدة.',
  '- INSUFFICIENT_EVIDENCE: إذا لم تكفِ النصوص المعروضة، فاذكر ذلك بلا حكم.',
  'قواعد الحكم:',
  '1) لا تُفتِ من معرفتك العامة ولا من الخلاصة وحدها؛ الحكم من النصوص المعروضة فقط.',
  '2) لا تستشهد بمقطع لم يُعرض عليك؛ الاستشهاد بمعرّف غير معروض يُرفض.',
  '3) لا تفترض معلومة غائبة؛ إن توقف الحكم على معلومة ناقصة فاطلبها بـ NEED_INFO.',
  '4) لا تُعِد فتح ما ثبت من كلام المستخدمة بصيغة الشرط؛ قل «بما أن ...» ولا تقل «إذا كان ...».',
  '5) رتّب الجواب: (١) حالتك الآن، (٢) ماذا تفعلين الآن، (٣) السبب باختصار، (٤) تنبيه واحد فقط إن كان ثمة ما قد يغيّر الحكم، (٥) الدليل/المصدر. ابدأ بالحالة والفعل، ولا تبدأ بسلسلة شروط.',
  '6) لغة يومية وجمل قصيرة، بلا إخلال بدقة الحكم ولا إضعاف الدليل.',
  '7) في «الدليل» اذكر اسم المصدر المعتمد (المكتوب بين القوسين قبل النص)، ولا تكتب معرّفات المقاطع في كلام المستخدمة؛ المعرّفات مكانها حقل evidenceRefs فقط.',
  'أجب بـ JSON فقط بالشكل:',
  '{"status":"ANSWER|NEED_INFO|INSUFFICIENT_EVIDENCE",',
  ' "message":"نص الجواب للمستخدمة عند ANSWER أو INSUFFICIENT_EVIDENCE",',
  ' "question":"السؤال الواحد عند NEED_INFO",',
  ' "evidenceRefs":["معرّفات المقاطع المعروضة التي استندت إليها عند ANSWER"]}',
].join('\n');

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bounded = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
/** Keep the MOST RECENT text when a bounded block overflows (the newest turn matters most). */
const boundedTail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);

function parseDecision(text: string): MindDecision | null {
  const cleaned = text.replace(/^```(?:json)?|```$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const status = str(o.status).toUpperCase().replace(/[\s-]/g, '_') as MindStatus;
  if (!['NEED_INFO', 'NEED_EVIDENCE', 'ANSWER', 'INSUFFICIENT_EVIDENCE'].includes(status)) return null;
  const list = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : undefined;
  const shortList = (v: unknown, max: number, each: number): string[] | undefined => {
    const l = list(v);
    return l ? l.map((x) => bounded(x, each)).slice(0, max) : undefined;
  };
  return {
    status,
    ...(shortList(o.knownFacts, 6, 160) ? { knownFacts: shortList(o.knownFacts, 6, 160)! } : {}),
    ...(shortList(o.evidenceNeeded, 3, 200) ? { evidenceNeeded: shortList(o.evidenceNeeded, 3, 200)! } : {}),
    ...(str(o.message) ? { message: bounded(str(o.message), 1200) } : {}),
    ...(str(o.question) ? { question: bounded(str(o.question), MAX_QUESTION_CHARS) } : {}),
    ...(str(o.key) ? { key: str(o.key) } : {}),
    ...(list(o.searchQueries) ? { searchQueries: list(o.searchQueries)!.slice(0, MAX_QUERIES) } : {}),
    ...(list(o.evidenceRefs) ? { evidenceRefs: list(o.evidenceRefs)! } : {}),
    ...(str(o.understanding) ? { understanding: bounded(str(o.understanding), 300) } : {}),
    ...(str(o.reason) ? { reason: bounded(str(o.reason), 200) } : {}),
  };
}

/** Bounded snake_case identity for the ONE question (never a domain vocabulary). */
function questionKey(declared: string | undefined): string {
  const k = (declared ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return k || DEFAULT_QUESTION_KEY;
}

interface MindDeps {
  readiness: { evaluate(input: { requirements: DecisionRequirement[]; known: KnownContextItem[] }): ReadinessResult };
}

export function createFiqhHaydMindSkill(deps: MindDeps): SkillDefinition {
  return {
    id: MIND_SKILL_ID,
    version: MIND_SKILL_VERSION,
    description: 'Naqaa Mind Skill V0 (experiment): one LLM-driven fiqh intelligence over the existing KIP infrastructure.',
    // No static readiness requirements: this skill reasons about its OWN material need and
    // returns the verdict it computed (the existing K22 evaluator stays the only one).
    requirements: { understanding: true, memory: true, knowledge: true, model: true },

    validateInput(input: unknown) {
      return input && typeof input === 'object' ? { ok: true } : { ok: false, message: 'input must be an object' };
    },
    validateOutput(output: unknown) {
      const o = output as Record<string, unknown> | null;
      const ok = o && typeof o === 'object' && (typeof o.answer === 'object' || typeof o.readiness === 'object');
      return ok ? { ok: true } : { ok: false, message: 'an answer or a readiness verdict is required' };
    },

    async execute(ctx: SkillExecutionContext) {
      const input = (ctx.input ?? {}) as {
        text?: unknown;
        context?: Record<string, unknown>;
        factMeta?: Record<string, { provenance?: string; certainty?: string }>;
        recentTurns?: Array<{ role?: string; text?: string }>;
      };
      const text = str(input.text);
      const facts = input.context ?? {};
      const factMeta = input.factMeta ?? {};
      const turns = Array.isArray(input.recentTurns) ? input.recentTurns : [];
      let modelCalls = 0;
      let knowledgeSearches = 0;
      const notes: string[] = ['mind_v0.1-p0'];
      const gap = (reason: string, message: string, extra: Record<string, unknown> = {}) => {
        const { notes: extraNotes, ...rest } = extra as { notes?: unknown } & Record<string, unknown>;
        return {
          status: 'completed',
          answer: { text: message },
          trace: {
            ...rest,
            status: 'INSUFFICIENT_EVIDENCE',
            workload: WORKLOAD,
            sourceSupport: 'UNSUPPORTED',
            notes: [...notes, reason, ...(Array.isArray(extraNotes) ? (extraNotes as string[]) : [])].slice(0, 6),
          },
        };
      };

      // 1. Approved sources are the only knowledge this skill may ever use.
      const approved = await ctx.knowledge!.resolveSources([...APPROVED_SOURCE_TITLES]);
      if (approved.length === 0) return gap('approved_sources_missing', 'المصدر المعتمد عندي ما يكفي لحسم هذه الصورة بدقة.');
      const approvedIds = approved.map((s) => s.id);

      // 2. The case exactly as the user described it: current message + bounded recent turns
      //    + known facts WITH their certainty (so the model can tell known from uncertain).
      const knownLines = Object.entries(facts)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => `- ${k} = ${bounded(String(v), 120)} (${factMeta[k]?.certainty ?? 'CERTAIN'}, ${factMeta[k]?.provenance ?? 'user'})`);
      // The Mind's OWN questions travel with the user's answers: a short answer («اي») is
      // meaningless without the question it answers, and re-asking an already-answered
      // question is exactly the failure this iteration removes.
      const narrative = [
        ...turns
          .filter((t) => (t.role === 'user' || t.role === 'assistant') && str(t.text))
          .map((t) => `${t.role === 'user' ? 'المستخدمة' : 'أنت سألت'}: ${str(t.text)}`),
        `المستخدمة: ${text}`,
      ]
        .filter(Boolean)
        .join('\n');
      const caseBlock = [
        'سياق الحوار كما جرى (الأحدث آخرًا؛ «المستخدمة» كلامها و«أنت سألت» أسئلتك السابقة):',
        boundedTail(narrative, MAX_CASE_CHARS),
        knownLines.length > 0 ? `حقائق معروفة:\n${knownLines.join('\n')}` : 'حقائق معروفة: (لا شيء)',
      ].join('\n\n');

      const ask = (d: MindDecision, extra: Record<string, unknown> = {}) => {
        const key = questionKey(d.key);
        const wording = bounded(str(d.question), MAX_QUESTION_CHARS);
        // Compatibility adapter (smallest possible): the ONE model-chosen question is relayed
        // as ONE material requirement through the EXISTING readiness evaluator, so Core renders
        // it and keeps its "exactly one question" rule. Core never chooses the fiqh question.
        const readiness = deps.readiness.evaluate({
          requirements: [{ key, description: wording, material: true, question: { key, wording } }],
          known: [],
        });
        return {
          status: 'completed',
          readiness,
          trace: {
            status: 'NEED_INFO',
            requirementKeys: [key],
            notes: [...notes, ...(d.reason ? [`reason=${d.reason}`] : [])].slice(0, 6),
            workload: WORKLOAD,
            ...(d.understanding ? { issue: d.understanding } : {}),
            ...extra,
          },
        };
      };

      // 3. Decision #1 — understanding only: ask, or say what evidence is needed.
      const first = await ctx.model!.generateText({
        workload: WORKLOAD,
        message: `${MIND_INSTRUCTION}\n\nالمرحلة: فهم أولي (لم تُعرض نصوص بعد).\n\n${caseBlock}`,
        maxOutputTokens: MIND_MAX_OUTPUT_TOKENS,
      });
      modelCalls += 1;
      const d1 = parseDecision(first.text);
      if (!d1) return gap('unreadable_model_output', 'أحتاج إعادة صياغة أوضح حتى أتمكن من المتابعة.');
      if (d1.status === 'NEED_INFO' && d1.question) return ask(d1, { model: str(first.model) });
      const queries = (d1.searchQueries ?? []).filter(Boolean).slice(0, MAX_QUERIES);
      if (queries.length === 0) {
        // No question and no evidence request: ask for the smallest thing that unblocks reasoning.
        return ask({ status: 'NEED_INFO', question: 'هل يمكنك توضيح الحالة قليلًا: ما الذي نزل، ومتى بدأ، وهل ما زال مستمرًا؟' }, { model: str(first.model) });
      }

      // 4. Retrieval — the existing project-scoped, approved-source knowledge tool.
      const passages = new Map<string, SkillKnowledgePassage>();
      for (const q of queries) {
        knowledgeSearches += 1;
        const hits = await ctx.knowledge!.search({ query: q, topK: MAX_TOP_K, sourceIds: approvedIds });
        for (const h of hits) if (h.sourceId && approvedIds.includes(h.sourceId)) passages.set(h.chunkId, h);
      }
      const top = [...passages.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 2);
      for (const p of top) {
        const neighbours = await ctx.knowledge!.adjacent(p.chunkId, 1);
        for (const n of neighbours) if (!passages.has(n.chunkId) && approvedIds.includes(n.sourceId)) passages.set(n.chunkId, n);
      }
      const evidence = [...passages.values()].slice(0, MAX_EVIDENCE);
      const validIds = new Set(evidence.map((p) => p.chunkId));
      const evidenceTrace = evidence.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId }));
      const traceBase = {
        approvedSourceIds: approvedIds,
        evidence: evidenceTrace,
        retrievedEvidenceIds: evidence.map((p) => p.chunkId),
        workload: WORKLOAD,
      };
      if (evidence.length === 0) {
        return gap('no_approved_source_evidence_retrieved', 'المصدر المعتمد عندي ما يكفي لحسم هذه الصورة بدقة.', {
          ...traceBase,
          notes: [`model_calls=${modelCalls}`, `knowledge_queries=${knowledgeSearches}`],
        });
      }

      // 5. Decision #2 — reason over the passages and answer, ask, or declare the gap.
      const evidenceBlock = evidence
        .map((p) => `[${p.chunkId}] (${p.sourceTitle}) ${bounded(p.text, 1400)}`)
        .join('\n\n');
      // P0.1 handoff: Call #1's compact conclusions (issue / accepted facts / what the
      // evidence must establish) — NOT the conversation, NOT the full case block, and
      // never its hidden reasoning. Call #2 keeps authority to answer, ask, or decline.
      const knownFacts = (d1.knownFacts ?? []).filter(Boolean).slice(0, 6);
      const evidenceNeeded = (d1.evidenceNeeded ?? []).filter(Boolean).slice(0, 3);
      const handoffBlock = [
        'خلاصة فهم الحالة من المرحلة السابقة (تمثيل للحالة وليست حكمًا):',
        `- الفهم: ${str(d1.understanding) || '(غير متوفر)'}`,
        knownFacts.length > 0 ? `- حقائق مثبتة من كلام المستخدمة:\n${knownFacts.map((f) => `  • ${f}`).join('\n')}` : '- حقائق مثبتة: (لا شيء)',
        evidenceNeeded.length > 0 ? `- المطلوب إثباته من النصوص:\n${evidenceNeeded.map((e) => `  • ${e}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const second = await ctx.model!.generateText({
        workload: WORKLOAD,
        message: `${MIND_ANSWER_INSTRUCTION}\n\n${handoffBlock}\n\nالنصوص المعتمدة:\n${evidenceBlock}`,
        maxOutputTokens: MIND_MAX_OUTPUT_TOKENS,
      });
      modelCalls += 1;
      const d2 = parseDecision(second.text);
      const counters = [`model_calls=${modelCalls}`, `knowledge_queries=${knowledgeSearches}`];
      const handoffCounters = [`handoff_facts=${knownFacts.length}`, `handoff_needed=${evidenceNeeded.length}`];
      const searched = { ...traceBase, ...(str(second.model) ? { model: str(second.model) } : {}), notes: [...handoffCounters, ...counters] };
      if (!d2) return gap('unreadable_model_output', 'تعذّر ترتيب الجواب من النصوص المعتمدة.', searched);
      if (d2.status === 'NEED_INFO' && d2.question) {
        return ask(d2, { ...traceBase, model: str(second.model), notes: [...handoffCounters, ...counters] });
      }
      if (d2.status !== 'ANSWER') {
        return gap('mind_reported_insufficient_evidence', bounded(d2.message ?? 'النصوص المعتمدة لا تكفي لحسم هذه الحالة.', 1200), searched);
      }
      // 6. Citation validation (fail-closed): only actually-retrieved approved chunks count.
      const accepted = (d2.evidenceRefs ?? []).filter((id) => validIds.has(id)).slice(0, 6);
      if (accepted.length === 0) {
        return gap('answer_without_valid_citation', 'النصوص المعتمدة لا تكفي لحسم هذه الحالة بدقة.', {
          ...searched,
          notes: [...counters, 'citation_rejected'],
        });
      }
      return {
        status: 'completed',
        answer: {
          text: bounded(str(d2.message), 1200),
          ...(evidence.find((p) => p.chunkId === accepted[0])?.sourceTitle ? { sourceTitle: evidence.find((p) => p.chunkId === accepted[0])!.sourceTitle } : {}),
          evidenceIds: accepted,
        },
        trace: {
          ...searched,
          status: 'ANSWER',
          acceptedEvidenceRefs: accepted,
          sourceSupport: 'SUPPORTED',
          decisionStatus: 'ANSWER',
          ...(d2.understanding ? { issue: d2.understanding } : {}),
          notes: [...handoffCounters, ...counters],
        },
      };
    },
  };
}
