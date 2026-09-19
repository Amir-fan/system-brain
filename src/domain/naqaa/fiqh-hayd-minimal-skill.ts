/**
 * Naqaa Minimal Mind — radical runtime resolution (K29-RADICAL).
 *
 * Final execution shape:
 *
 *   User + conversation + approved sources
 *     → ONE model call (with structured schema for the WHOLE turn output)
 *       → if it emits `USE_TOOL {tool,query}`      → execute ONE Knowledge search, append evidence,
 *                                                    loop (with remaining tool budget + terminal hint)
 *       → if it emits `TERMINAL {status, ...}`     → validate + return
 *       → if it emits nothing parseable            → fail-closed with reason
 *   Bounded: MAX_TOOL_CALLS=2 (was 4), MAX_MODEL_CALLS=4 (was 6).
 *   Deduplication: identical queries within the turn reuse the previous evidence block.
 *   Reasoning + output budget are passed per-call (workload-scoped from the Skill).
 *
 * This is execution/trust plumbing only; domain reasoning stays with the LLM.
 */

import type { SkillDefinition, SkillExecutionContext, SkillKnowledgePassage } from '../../core/skill/skill.ts';
import type { DecisionRequirement, KnownContextItem, ReadinessResult } from '../../core/readiness/readiness.ts';
import { APPROVED_SOURCE_TITLES } from './fiqh-hayd-contracts.ts';

export const MINIMAL_SKILL_ID = 'naqaa.fiqh-hayd-minimal';
export const MINIMAL_SKILL_VERSION = 3; // v2 → v3: single terminal envelope, workload-scoped budget, dedup
/** Provenance marker — emitted on EVERY terminal path. */
export const MINIMAL_TRACE_MARKER = 'minimal_mind_v0';

const WORKLOAD = 'knowledge_answer';
/** Workload-scoped output budget — fits a Naqaa answer + ASK_USER; far below the gateway's 16 384. */
// 2048: enough headroom for ~1500 tokens of reasoning + ~500 tokens for the JSON envelope.
// The Skill asks for `reasoning: 'off'` (see below) so reasoning is suppressed; this is a
// safety budget, not a steady-state one.
const MAX_OUTPUT_TOKENS = 2048;
/** EXECUTION bound: hard ceiling on Knowledge searches per turn (was 4; lowered because the
 *  structured envelope reduces duplicate-emit pressure). */
export const MAX_TOOL_CALLS = 2;
/** EXECUTION bound: hard ceiling on model calls per turn. */
export const MAX_MODEL_CALLS = MAX_TOOL_CALLS + 2;
/** Retrieval detail (KIP-owned). */
const TOOL_TOP_K = 3;
const TOOL_PASSAGE_CHARS = 1400;
const MAX_CONVERSATION_CHARS = 3000;
const MAX_QUESTION_CHARS = 300;
const DEFAULT_QUESTION_KEY = 'minimal_followup';

/**
 * ONE canonical response envelope for the WHOLE turn. The model picks ONE of two top-level
 * actions; this is the single source of truth for the Skill's terminal contract, the
 * structured-output schema, and the parser. `USE_TOOL` carries the search query; `TERMINAL`
 * carries the final outcome. We deliberately do NOT model a tool request inside a terminal
 * envelope (the source of the P0.4 ambiguity).
 */
// The structured schema shapes what the provider is LIKELY to emit; the parser is the
// authority. The schema therefore permits either envelope (USE_TOOL/TERMINAL or bare
// {status}) so a model that drops the action label is still parsed correctly.
const MINIMAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['USE_TOOL', 'TERMINAL'] },
    tool: { type: 'string', enum: ['search_knowledge'] },
    query: { type: 'string' },
    status: { type: 'string', enum: ['ANSWER', 'ASK_USER', 'INSUFFICIENT_EVIDENCE'] },
    message: { type: 'string' },
    question: { type: 'string' },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
  },
  anyOf: [{ required: ['action'] }, { required: ['status'] }],
  additionalProperties: false,
} as const;
const MINIMAL_RESPONSE_FORMAT = { name: 'minimal_response', strict: true, schema: MINIMAL_RESPONSE_SCHEMA } as const;

const MINIMAL_INSTRUCTION = [
  'أنت العقل الفقهي المتخصص لتطبيق نقاء.',
  '',
  'مهمتك مساعدة المستخدمة في مسائل الحيض وما يتصل بها وفق المعتمد في المذهب الشافعي، اعتمادًا على المصادر المعتمدة المتاحة لك داخل KIP.',
  '',
  'افهم كلام المستخدمة بصورة طبيعية في ضوء المحادثة والسياق المتاح لك.',
  '',
  'لا تطلب منها معلومة سبق أن ذكرتها.',
  '',
  'إذا كانت هناك معلومة ناقصة تؤثر فعلًا في الحكم، اسأل عنها بسؤال واحد واضح ومباشر. لا تسأل لمجرد استكمال نموذج معلومات.',
  '',
  'قبل إعطاء حكم فقهي، استخدم أداة البحث في المصادر المعتمدة. لا تعتمد على معلوماتك العامة بدل المصادر المعتمدة.',
  '',
  'ابحث عما تحتاجه للمسألة نفسها فقط؛ لا تكرر نفس الاستعلام ولا تستدعِ ما حصلتَ عليه.',
  '',
  'لا يكفي أن تجد نصًا يؤيد نتيجة محتملة؛ افهم النصوص ذات الصلة وشروطها واستثناءاتها، ثم طبّقها على الحالة.',
  '',
  'إذا لم تكن المعلومات أو الأدلة كافية، قل ذلك أو اسأل عن المعلومة المؤثرة فقط.',
  '',
  'لا تخترع واقعة لم تقلها المستخدمة.',
  '',
  'اجعل الرد بسيطًا ومباشرًا: ابدأ بحالتها وما الذي تفعله، ثم السبب المختصر، ثم التنبيه عند الحاجة، ثم المصدر.',
  '',
  'خاطبي المستخدمة بلغة بسيطة جدًا وواضحة، بحيث تفهم الجوابَ المستخدمةُ العادية دون معرفة فقهية مسبقة.',
  '',
  'تجنبي المصطلحات الفقهية المتخصصة ما أمكن، وإذا احتجتِ مصطلحًا فاشرحيه بكلمات سهلة.',
  '',
  'اجعلي طول الجواب متناسبًا مع السؤال: السؤال البسيط جوابه بسيط، والمسألة المعقدة تأخذ ما تحتاجه.',
  'لا تحولي السؤال البسيط إلى درس فقهي.',
  '',
  'واجهة التنفيذ (هذه ليست طريقة تفكير، بل صيغة الإخراج الموحّدة في كل رد):',
  '  - إذا احتجتِ دليلًا جديدًا: {"action":"USE_TOOL","tool":"search_knowledge","query":"نص البحث"}',
  '  - لإجابة نهائية مع الدليل: {"action":"TERMINAL","status":"ANSWER","message":"نص الجواب","evidenceRefs":["معرّف المقطع"]}',
  '  - لطلب معلومة واحدة مؤثرة: {"action":"TERMINAL","status":"ASK_USER","question":"السؤال"}',
  '  - إذا لم يكفِ الدليل المتاح: {"action":"TERMINAL","status":"INSUFFICIENT_EVIDENCE","message":"بيان مختصر"}',
  '  - لا تكتب أي نص خارج الـ JSON، ولا تستخدم أكواد JSON Schema أو Markdown fences.',
  `- يبقى لك ${MAX_TOOL_CALLS} عمليات بحث بحد أقصى في الدور الواحد.`,
  '- evidenceRefs يقبل فقط معرّفات مقاطع ظهرت لك من نتيجة الأداة في هذا الدور.',
].join('\n');

interface MinimalResponse {
  action: 'USE_TOOL' | 'TERMINAL';
  tool?: 'search_knowledge';
  query?: string;
  status?: 'ANSWER' | 'ASK_USER' | 'INSUFFICIENT_EVIDENCE';
  message?: string;
  question?: string;
  evidenceRefs?: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bounded = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const boundedTail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s);
const normalizeQuery = (q: string): string => q.replace(/\s+/g, ' ').trim();

/**
 * Parser is the source of truth. The structured schema guides the model; the parser
 * accepts both the canonical envelope (action + payload) and the legacy bare
 * {status, message, evidenceRefs, question} shape — a model that omits the action label
 * is still parsed correctly.
 */
function parseModelResponse(text: string): MinimalResponse | null {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?|```$/g, '').trim();
  // Find the FIRST well-formed JSON object in the output (the model may emit leading
  // prose before the answer). We bracket from each '{' and try each closing '}' until
  // one parses as an object — not the outermost '{...}' (which can swallow a stray '}').
  let raw: unknown;
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let j = i; j < cleaned.length; j += 1) {
      const c = cleaned[j];
      if (inStr) {
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try { raw = JSON.parse(cleaned.slice(i, j + 1)); } catch { raw = undefined; break; }
          if (raw && typeof raw === 'object') break;
          raw = undefined;
        }
      }
    }
    if (raw && typeof raw === 'object') break;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const action = str(o.action).toUpperCase();
  if (action === 'USE_TOOL') {
    const tool = str(o.tool);
    const query = normalizeQuery(str(o.query));
    if (tool !== 'search_knowledge' || !query) return null;
    return { action: 'USE_TOOL', tool: 'search_knowledge', query: bounded(query, 300) };
  }
  const status = str(o.status).toUpperCase().replace(/[\s-]/g, '_');
  if (!['ANSWER', 'ASK_USER', 'INSUFFICIENT_EVIDENCE'].includes(status)) return null;
  const refs = Array.isArray(o.evidenceRefs)
    ? o.evidenceRefs.map((x) => str(x)).filter(Boolean).slice(0, 6)
    : undefined;
  return {
    action: 'TERMINAL',
    status: status as MinimalResponse['status'],
    ...(str(o.message) ? { message: bounded(str(o.message), 1600) } : {}),
    ...(str(o.question) ? { question: bounded(str(o.question), MAX_QUESTION_CHARS) } : {}),
    ...(refs && refs.length > 0 ? { evidenceRefs: refs } : {}),
  };
}

interface MinimalDeps {
  readiness: { evaluate(input: { requirements: DecisionRequirement[]; known: KnownContextItem[] }): ReadinessResult };
}

export function createFiqhHaydMinimalSkill(deps: MinimalDeps): SkillDefinition {
  return {
    id: MINIMAL_SKILL_ID,
    version: MINIMAL_SKILL_VERSION,
    description: 'Naqaa Minimal Mind (experiment): one LLM with an approved-Knowledge tool over existing KIP infrastructure.',
    requirements: { understanding: false, memory: false, knowledge: true, model: true },

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
        recentTurns?: Array<{ role?: string; text?: string }>;
      };
      const text = str(input.text);
      const turns = Array.isArray(input.recentTurns) ? input.recentTurns : [];

      let modelCalls = 0;
      let toolCalls = 0;
      const queries: string[] = [];
      const returned: SkillKnowledgePassage[] = [];
      /** Per-turn evidence cache: identical normalised query reuses the last result. */
      const cache = new Map<string, { rendered: string; newChunks: SkillKnowledgePassage[] }>();

      const notes = (extra: string[] = []): string[] =>
        [MINIMAL_TRACE_MARKER, `v=${MINIMAL_SKILL_VERSION}`, `model_calls=${modelCalls}`, `tool_calls=${toolCalls}`, ...extra];

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
            notes: notes([reason, ...(Array.isArray(extraNotes) ? (extraNotes as string[]) : [])]).slice(0, 8),
          },
        };
      };

      // 1. Approved sources (KIP boundary).
      const approved = await ctx.knowledge!.resolveSources([...APPROVED_SOURCE_TITLES]);
      if (approved.length === 0) return gap('approved_sources_missing', 'المصادر المعتمدة غير متاحة الآن.');
      const approvedIds = approved.map((s) => s.id);

      // 2. Natural conversation.
      const conversation = [
        ...turns
          .filter((t) => (t.role === 'user' || t.role === 'assistant') && str(t.text))
          .map((t) => `${t.role === 'user' ? 'المستخدمة' : 'المساعد'}: ${str(t.text)}`),
        `المستخدمة: ${text}`,
      ]
        .filter(Boolean)
        .join('\n');

      let interaction = `${MINIMAL_INSTRUCTION}\n\nالمحادثة:\n${boundedTail(conversation, MAX_CONVERSATION_CHARS)}`;

      const askTool = async (query: string): Promise<{ rendered: string; newChunks: SkillKnowledgePassage[] }> => {
        const norm = normalizeQuery(query);
        const hit = cache.get(norm);
        if (hit) return hit;
        toolCalls += 1;
        queries.push(bounded(query, 120));
        const hits = await ctx.knowledge!.search({ query, topK: TOOL_TOP_K, sourceIds: approvedIds });
        const keep = hits.filter((h) => h.sourceId && approvedIds.includes(h.sourceId));
        for (const h of keep) if (!returned.some((p) => p.chunkId === h.chunkId)) returned.push(h);
        const rendered = keep.length === 0
          ? 'نتيجة الأداة: لا توجد مقاطع معتمدة مطابقة.'
          : `نتيجة الأداة (مصادر معتمدة):\n${keep
              .map((p) => `[${p.chunkId}] (${p.sourceTitle}) ${bounded(p.text, TOOL_PASSAGE_CHARS)}`)
              .join('\n\n')}`;
        const entry = { rendered, newChunks: keep };
        cache.set(norm, entry);
        return entry;
      };

      // 3. ONE intelligence with bounded tool loop.
      for (;;) {
        if (modelCalls >= MAX_MODEL_CALLS) {
          return gap('model_call_bound_reached', 'الدليل المتاح غير كافٍ للحكم الآن.', {
            retrievedEvidenceIds: [...returned.map((p) => p.chunkId)],
            notes: [`queries=${queries.join(' | ')}`],
          });
        }
        modelCalls += 1;
        const out = await ctx.model!.generateText({
          workload: WORKLOAD,
          message: interaction,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseFormat: MINIMAL_RESPONSE_FORMAT,
          // K29-RADICAL: workload-scoped reasoning hint. Other Skills stay on the default
          // (provider-defined) budget. For Naqaa, 'off' is empirically the right choice —
          // the terminal envelope is small and the model otherwise burns the entire
          // output budget on hidden reasoning (finish_reason=length, content=null).
          reasoning: 'off',
        });
        const parsed = parseModelResponse(out.text);
        if (!parsed) {
          return gap('unreadable_model_output', 'تعذّر ترتيب الجواب الآن. حاولي مرة أخرى.', {
            ...(str(out.model) ? { model: str(out.model) } : {}),
            notes: [`calls=${modelCalls}`, `tools=${toolCalls}`, `queries=${queries.join(' | ')}`],
          });
        }

        if (parsed.action === 'USE_TOOL') {
          if (toolCalls >= MAX_TOOL_CALLS) {
            // Reached the bound: tell the model to TERMINAL now. Same execution bound, no extra call.
            const qAtBound = parsed.query ?? '';
            interaction += `\n\nطلبك: {"action":"USE_TOOL","tool":"search_knowledge","query":"${qAtBound}"}\nبلغتَ الحد الأقصى لعمليات البحث (${MAX_TOOL_CALLS}). لا تطلب بحثًا آخر: ارجع بـ TERMINAL بناءً على ما لديك.`;
            continue;
          }
          const qForTool = parsed.query ?? '';
          const { rendered } = await askTool(qForTool);
          interaction += `\n\nطلبك: {"action":"USE_TOOL","tool":"search_knowledge","query":"${bounded(qForTool, 300)}"}\n${rendered}`;
          continue;
        }

        // parsed.action === 'TERMINAL'
        const modelName = str(out.model) ? { model: str(out.model) } : {};

        if (parsed.status === 'ASK_USER') {
          if (!parsed.question) {
            return gap('terminal_missing_question', 'تعذّر ترتيب الجواب الآن. حاولي مرة أخرى.', { ...modelName });
          }
          const key = DEFAULT_QUESTION_KEY;
          const readiness = deps.readiness.evaluate({
            requirements: [{ key, description: parsed.question, material: true, question: { key, wording: parsed.question } }],
            known: [],
          });
          return {
            status: 'completed',
            readiness,
            trace: { status: 'NEED_INFO', requirementKeys: [key], workload: WORKLOAD, notes: notes(), ...modelName },
          };
        }

        if (parsed.status === 'ANSWER') {
          const returnedIds = new Set(returned.map((p) => p.chunkId));
          const accepted = (parsed.evidenceRefs ?? []).filter((id) => returnedIds.has(id)).slice(0, 6);
          if (accepted.length === 0) {
            return gap('answer_without_tool_evidence', 'الدليل المتاح غير كافٍ للحكم الآن.', {
              ...modelName,
              retrievedEvidenceIds: [...returnedIds],
              notes: [`queries=${queries.join(' | ')}`],
            });
          }
          const first = returned.find((p) => p.chunkId === accepted[0]);
          return {
            status: 'completed',
            answer: {
              text: parsed.message ?? '',
              ...(first?.sourceTitle ? { sourceTitle: first.sourceTitle } : {}),
              evidenceIds: accepted,
            },
            trace: {
              ...modelName,
              status: 'ANSWER',
              acceptedEvidenceRefs: accepted,
              retrievedEvidenceIds: [...returnedIds],
              evidence: returned.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId })),
              approvedSourceIds: approvedIds,
              sourceSupport: 'SUPPORTED',
              workload: WORKLOAD,
              notes: notes([`queries=${queries.join(' | ')}`]).slice(0, 8),
            },
          };
        }

        // INSUFFICIENT_EVIDENCE
        return gap('mind_reported_insufficient_evidence', parsed.message ?? 'الدليل المتاح غير كافٍ للحكم.', {
          ...modelName,
          retrievedEvidenceIds: [...returned.map((p) => p.chunkId)],
          notes: [`queries=${queries.join(' | ')}`],
        });
      }
    },
  };
}