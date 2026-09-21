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
/**
 * How this Mind shapes its answer output. Per-Skill static config (KIP enforces the
 * contract; the LLM still owns the content).
 *  - natural:  plain text answer; structured response NOT requested.
 *  - flexible: LLM MAY use the structured semantic fields when useful; a plain-text
 *              terminal is still accepted (never a failure).
 *  - required: the structured envelope is requested AND the minimum is enforced —
 *              `summary` is mandatory on ANSWER; every other field stays optional.
 * Naqaa Minimal currently runs `required`.
 */
export type ResponseMode = 'natural' | 'flexible' | 'required';

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
    // RX1 semantic parts — ALL optional. The LLM fills only what genuinely helps the
    // ordinary user; KIP stores semantics, never colors/design.
    understanding: { type: 'string' },
    summary: { type: 'string' },
    explanation: { type: 'string' },
    practical: { type: 'string' },
    visual: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['timeline'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, duration: { type: 'string' } },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      required: ['type', 'items'],
      additionalProperties: false,
    },
    nextAction: { type: 'string' },
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
  'أسلوب الجواب — أنت فقيه موثوق يشرح لامرأة عادية، لا فقيه يكتب لفقيه:',
  '  - عربية بسيطة جدًا، جمل قصيرة وواضحة.',
  '  - تجنبي المصطلحات الفقهية المعقدة؛ إن اضطررتِ لمصطلح فاشرحيه بكلمات سهلة.',
  '  - لا مقدمة طويلة، ولا تعيدي سؤال المستخدمة كاملًا.',
  '  - قدّمي الخلاصة مبكرًا، واشرحي السبب بأقصر قدر كافٍ.',
  '  - إن كان للحكم أثر عملي على المستخدمة فوضّحيه.',
  '  - لا تعطي درسًا فقهيًا طويلًا إلا إذا طلبت التفاصيل.',
  '  - لا تختمي تلقائيًا بـ«هل لديك سؤال آخر؟».',
  '  - إن وُجدت خطوة تالية مفيدة فعلًا فاقترحيها باختصار.',
  '',
  'إذا كانت معلومة مادية ناقصة: لا تفترضيها — اسألي سؤالًا توضيحيًا قصيرًا (ASK_USER) بدل حكم شكلي.',
  '',
  'السؤال الحالي هو آخر سطر للمستخدمة في المحادثة أدناه — أجيبي عنه هو. الأسطر السابقة سياق ومساند، وليست المطلوب.',
  '',
  'أجزاء الجواب (ضعيها في حقول JSON المقابلة — summary هو أهم حقل عند الإجابة، والباقي اختياري حسب الفائدة):',
  '  - summary: الخلاصة المباشرة في سطر واحد — أهم جزء للمستخدمة. ضعيها في الحقل summary وحدها؛ لا تكتبي كلمة «الخلاصة» داخل message.',
  '  - understanding: تأكيد شديد الاختصار لفهم الحالة المركبة (مثل: «3 أيام دم، ثم 5 أيام نقاء، ثم 4 أيام دم»). لا تستخدميه في السؤال البسيط.',
  '  - explanation: سبب مبسط، 1–3 جمل غالبًا.',
  '  - practical: ما الذي يعنيه الحكم عمليًا للمستخدمة، إن وُجد.',
  '  - visual: فقط عندما يساعد عرض زمني في الفهم — {"type":"timeline","items":[{"label":"دم","duration":"3 أيام"},...]}. لا ألوان ولا تصميم — معنى فقط.',
  '  - nextAction: خطوة تالية مفيدة مرتبطة بالسياق فقط، لا تجبري كل جواب عليها.',
  '  - message: النص الكامل البسيط للجواب (هو ما تعرضه المحادثة)، مرتبًا: الخلاصة أولًا، ثم السبب، ثم الأثر العملي، ثم المصدر.',
  '',
  'واجهة التنفيذ (هذه ليست طريقة تفكير، بل صيغة الإخراج الموحّدة في كل رد):',
  '  - إذا احتجتِ دليلًا جديدًا: {"action":"USE_TOOL","tool":"search_knowledge","query":"نص البحث"}',
  '  - لإجابة نهائية مع الدليل: {"action":"TERMINAL","status":"ANSWER","message":"نص الجواب","evidenceRefs":["معرّف المقطع"],"summary":"...","explanation":"...","practical":"..."}',
  '  - لطلب معلومة واحدة مؤثرة: {"action":"TERMINAL","status":"ASK_USER","question":"السؤال"}',
  '  - إذا لم يكفِ الدليل المتاح: {"action":"TERMINAL","status":"INSUFFICIENT_EVIDENCE","message":"بيان مختصر"}',
  '  - لا تكتب أي نص خارج الـ JSON، ولا تستخدم أكواد JSON Schema أو Markdown fences.',
  `- يبقى لك ${MAX_TOOL_CALLS} عمليات بحث بحد أقصى في الدور الواحد.`,
  '- evidenceRefs يقبل فقط معرّفات مقاطع ظهرت لك من نتيجة الأداة في هذا الدور.',
].join('\n');

interface MinimalTimelineItem { label: string; duration?: string }
interface MinimalVisual { type: 'timeline'; items: MinimalTimelineItem[] }

interface MinimalResponse {
  action: 'USE_TOOL' | 'TERMINAL';
  tool?: 'search_knowledge';
  query?: string;
  status?: 'ANSWER' | 'ASK_USER' | 'INSUFFICIENT_EVIDENCE';
  message?: string;
  question?: string;
  evidenceRefs?: string[];
  // RX1 semantic parts (all optional; the LLM decides what genuinely helps).
  understanding?: string;
  summary?: string;
  explanation?: string;
  practical?: string;
  visual?: MinimalVisual;
  nextAction?: string;
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
  // RX1 visual: accept only a well-formed semantic timeline; anything else is dropped
  // (never a parse failure — the visual is a presentation hint, not a verdict).
  let visual: MinimalVisual | undefined;
  if (o.visual && typeof o.visual === 'object') {
    const v = o.visual as Record<string, unknown>;
    if (str(v.type).toLowerCase() === 'timeline' && Array.isArray(v.items)) {
      const items = v.items
        .map((it) => {
          const r = (it ?? {}) as Record<string, unknown>;
          const label = str(r.label);
          return label ? { label: bounded(label, 40), ...(str(r.duration) ? { duration: bounded(str(r.duration), 40) } : {}) } : null;
        })
        .filter((x): x is MinimalTimelineItem => x !== null)
        .slice(0, 12);
      if (items.length > 0) visual = { type: 'timeline', items };
    }
  }
  return {
    action: 'TERMINAL',
    status: status as MinimalResponse['status'],
    ...(str(o.message) ? { message: bounded(str(o.message), 1600) } : {}),
    ...(str(o.question) ? { question: bounded(str(o.question), MAX_QUESTION_CHARS) } : {}),
    ...(refs && refs.length > 0 ? { evidenceRefs: refs } : {}),
    ...(str(o.understanding) ? { understanding: bounded(str(o.understanding), 300) } : {}),
    ...(str(o.summary) ? { summary: bounded(str(o.summary), 400) } : {}),
    ...(str(o.explanation) ? { explanation: bounded(str(o.explanation), 800) } : {}),
    ...(str(o.practical) ? { practical: bounded(str(o.practical), 400) } : {}),
    ...(visual ? { visual } : {}),
    ...(str(o.nextAction) ? { nextAction: bounded(str(o.nextAction), 200) } : {}),
  };
}

interface MinimalDeps {
  readiness: { evaluate(input: { requirements: DecisionRequirement[]; known: KnownContextItem[] }): ReadinessResult };
  /** Output shaping for THIS Mind. Defaults to 'required' (Naqaa Minimal's current mode). */
  responseMode?: ResponseMode;
}

export function createFiqhHaydMinimalSkill(deps: MinimalDeps): SkillDefinition {
  // Default is `flexible` (NOT `required`): live evidence on the current production model
  // (DeepSeek) shows that when `summary` is enforced fail-closed, the model answers well in
  // text but omits the field, and the enforced re-emit turns otherwise-valid answers into
  // `unreadable_model_output` failures. `flexible` uses the structured parts whenever the
  // model supplies them and accepts a plain-text answer otherwise — the safe default.
  // `required` remains available as an explicit opt-in for a model/path proven to comply.
  const responseMode: ResponseMode = deps.responseMode ?? 'flexible';
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
        // Session case facts + policy-gated personal-memory facts (provenance/certainty
        // attached). In private mode this block is EMPTY by construction (the conversation
        // never reads personal memory for private sessions), so reading it here is safe.
        context?: Record<string, unknown>;
        factMeta?: Record<string, { provenance?: string; certainty?: string }>;
      };
      const text = str(input.text);
      const turns = Array.isArray(input.recentTurns) ? input.recentTurns : [];
      const facts = input.context ?? {};
      const factMeta = input.factMeta ?? {};
      // Known facts the user/memory already established — the Mind must NOT re-ask these.
      // Rendered with provenance+certainty so the model can tell a user's own statement
      // from a weaker memory hint. (Calendared Naqaa data has no KIP surface yet — see
      // deferred note; only facts that already reach this payload are shown.)
      const knownLines = Object.entries(facts)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => {
          const m = factMeta[k] ?? {};
          const certainty = m.certainty ? String(m.certainty) : '';
          const provenance = m.provenance ? String(m.provenance) : '';
          const tag = [certainty, provenance].filter(Boolean).join('/');
          return `- ${k} = ${JSON.stringify(v)}${tag ? ` (${tag})` : ''}`;
        })
        .slice(0, 24)
        .join('\n');

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

      // 2. Natural conversation + known facts (so the Mind never re-asks what is known).
      const conversation = [
        ...turns
          .filter((t) => (t.role === 'user' || t.role === 'assistant') && str(t.text))
          .map((t) => `${t.role === 'user' ? 'المستخدمة' : 'المساعد'}: ${str(t.text)}`),
        `المستخدمة: ${text}`,
      ]
        .filter(Boolean)
        .join('\n');

      const knownBlock = knownLines ? `\n\nمعلومات معروفة مسبقًا (لا تسأل عنها من جديد):\n${knownLines}` : '';
      let interaction = `${MINIMAL_INSTRUCTION}\n\nالمحادثة:\n${boundedTail(conversation, MAX_CONVERSATION_CHARS)}${knownBlock}`;

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
          // response_mode: 'natural' never requests the structured envelope; 'flexible' and
          // 'required' both request it (the difference is enforcement, not the request).
          ...(responseMode === 'natural' ? {} : { responseFormat: MINIMAL_RESPONSE_FORMAT }),
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
          // response_mode = required: `summary` is the enforced minimum on ANSWER. If the
          // model answered but omitted it, ask for ONE terminal re-emit (no extra LLM
          // logic — same loop, one chance, then fail-closed). flexible/natural skip this.
          if (responseMode === 'required' && !parsed.summary) {
            if (modelCalls < MAX_MODEL_CALLS) {
              interaction += `\n\nردك السابق صالح كحكم لكنه ينقصه الحقل الإلزامي summary (الخلاصة المباشرة للمستخدمة). أعد إرسال الرد نفسه الآن بصيغة TERMINAL واملأ حقل summary. الحقول الأخرى اختيارية كما هي.`;
              continue;
            }
            return gap('required_summary_missing', 'تعذّر ترتيب الجواب الآن. حاولي مرة أخرى.', { ...modelName });
          }
          const first = returned.find((p) => p.chunkId === accepted[0]);
          // RX1: forward only the semantic parts the model actually supplied (no invented
          // parts; `text` remains the full display string for backward compatibility).
          const structured = {
            ...(parsed.understanding ? { understanding: parsed.understanding } : {}),
            ...(parsed.summary ? { summary: parsed.summary } : {}),
            ...(parsed.explanation ? { explanation: parsed.explanation } : {}),
            ...(parsed.practical ? { practical: parsed.practical } : {}),
            ...(parsed.visual ? { visual: parsed.visual } : {}),
            ...(parsed.nextAction ? { nextAction: parsed.nextAction } : {}),
          };
          return {
            status: 'completed',
            answer: {
              text: parsed.message ?? '',
              ...(first?.sourceTitle ? { sourceTitle: first.sourceTitle } : {}),
              evidenceIds: accepted,
              ...(Object.keys(structured).length > 0 ? { structured } : {}),
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