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
import type { DecisionRequirement, InteractionType, KnownContextItem, ReadinessResult } from '../../core/readiness/readiness.ts';
import { UNCERTAINTY_OPTION, hasContextValue, hasKnownValue, isInteractionType } from '../../core/readiness/readiness.ts';
import { isConfirmedMaterialFact } from '../../core/readiness/material-fact-admission.ts';
import { APPROVED_SOURCE_TITLES, FIQH_EVIDENCE_GAP_MESSAGE, FIQH_FACT_KEY_PATTERN, isFiqhDecisionMaterialFactKey } from './fiqh-hayd-contracts.ts';

export const MINIMAL_SKILL_ID = 'naqaa.fiqh-hayd-minimal';
export const MINIMAL_SKILL_VERSION = 10; // v9 → v10: preserve retrieved approved evidence when the model omits citations
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
/** Stage 4C.6: the ONLY structural ruling classifications the client can consume. */
const LABELS = ['hayd', 'istihada', 'nifas'] as const;
const LEGACY_QUESTION_KEY = 'minimal_followup';
const FACT_KEY_PATTERN = new RegExp(FIQH_FACT_KEY_PATTERN);
const isFactKey = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 60 && FACT_KEY_PATTERN.test(value)
  && !['constructor', 'prototype', LEGACY_QUESTION_KEY].includes(value);

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
    status: { type: 'string', enum: ['ANSWER', 'ASK_USER'] },
    message: { type: 'string' },
    question: { type: 'string' },
    /** Material Fact Confirmation: true when the ASK_USER question is a yes/no confirmation. */
    yesNo: { type: 'boolean' },
    /** Stable identity for every ASK_USER material fact, new or already present. */
    factKey: { type: 'string', pattern: FIQH_FACT_KEY_PATTERN, maxLength: 60 },
    answerType: { type: 'string', enum: ['number', 'duration', 'date', 'time', 'yes_no', 'single_choice', 'multiple_choice', 'free_text'] },
    /** Short, clear answer choices for the question (used INSTEAD of free text when the answer can be safely enumerated). */
    options: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
    materialFactKeys: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, minItems: 1, maxItems: 24 },
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
    // Stage 4C.6: the STRUCTURAL ruling classification the client consumes as decisionLabel.
    // The LLM classifies its own ANSWER in the same call — never derived from prose later.
    label: { type: 'string', enum: ['hayd', 'istihada', 'nifas'] },
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
  '  - عربية بسيطة جدًا، جمل قصيرة وواضحة، دافئة وقريبة (خليجية ميسّرة) — تفهمها بنت عمرها 12 سنة.',
  '  - تجنبي المصطلحات الفقهية المعقدة؛ إن اضطررتِ لمصطلح فاشرحيه بكلمات سهلة.',
  '  - لا مقدمة طويلة، ولا تعيدي سؤال المستخدمة كاملًا.',
  '  - قدّمي الخلاصة مبكرًا، واشرحي السبب بأقصر قدر كافٍ.',
  '  - إن كان للحكم أثر عملي على المستخدمة فوضّحيه.',
  '  - لا تعطي درسًا فقهيًا طويلًا إلا إذا طلبت التفاصيل.',
  '  - لا تختمي تلقائيًا بـ«هل لديك سؤال آخر؟».',
  '  - إن وُجدت خطوة تالية مفيدة فعلًا فاقترحيها باختصار.',
  '',
  'شكل الحكم الشخصي عند كفاية المعلومات:',
  '  1) الحكم أولًا وبشكل مباشر — مثل: «نعم، هذا يُعد حيضًا» أو «هذه الأيام كلها حيض».',
  '  2) السبب في جملة أو جملتين قصيرتين فقط.',
  '  3) ماذا تفعل الآن عمليًا — جملة واحدة عند وجود أثر عملي.',
  '',
  'ممنوع بدء الجواب بصيغ تقريرية باردة مثل: «بناءً على المعطيات»، «وفقًا للمعلومات المقدمة»، «بعد تحليل الحالة»، «يظهر من السؤال»، «بحسب ما سبق».',
  '',
  'لا تذكري أبدًا كلمات تقنية داخلية: لا «سياق»، لا «ذاكرة»، لا «نموذج»، لا «مصاديق»، لا «محرك». تكلمي كمختصة تتحدث للمستخدمة مباشرة.',
  '',
  'عند نقص معلومة مؤثرة: لا حكم نهائي، لكن لا برود أيضًا — لخّصي ما فهمتِه باختصار في understanding ثم اسألي حقيقة واحدة فقط (ASK_USER).',
  '',
  'أسلوب أسئلة الماسح (هذه أولوية ثابتة):',
  '  - عربية بيضاء شديدة البساطة — كلام طبيعي مفهوم لكل اللهجات، تفهمه بنت عمرها 12 سنة. قصيرة جدًا ومباشرة. لا فصحى رسمية ثقيلة ولا لهجة بلد معينة كأساس.',
  '  - إذا واضح من كلامها أنها تستخدم لهجة معينة، جاريها بخفة وطبيعية — بدون تكلف.',
  '  - ممنوع المقدمات الآلية: لا «حسب البيانات»، لا «بناءً على المعلومات»، لا «وفقًا للسياق». مثال الأسلوب: بدل «حسب البيانات، استمر نزول الدم معك 24 ساعة، هل هذا صحيح؟» قولي: «صار تقريبًا يوم من بداية نزول الدم؟».',
  '  - سؤال واحد فقط في الجولة. لا تجمعي سؤالين في جملة ولا تعرضي استبيانًا.',
  '',
  'نوع الإجابة — اختاري أقل مجهود ممكن للمستخدمة، بهذا الترتيب:',
  '  1. إذا كانت المعلومة موجودة ونحتاج فقط تأكيدها: سؤال نعم/لا مع yesNo (و«غير متأكدة» ستظهر لها تلقائيًا).',
  '  2. إذا كانت المعلومة ناقصة ويمكن حصر إجاباتها في خيارات قليلة واضحة بلا فقد معلومة يحتاجها الحكم: أرسلي options قصيرة وواضحة تختاريها أنتِ بحسب السؤال (و«غير متأكدة» تضاف تلقائيًا).',
  '  3. الكتابة الحرة (بلا options) حل أخير فقط — عندما تكون المعلومة مفتوحة أو دقيقة لدرجة أن الخيارات ستفقد معلومة يحتاجها الحكم.',
  '',
  'معنى «غير متأكدة»: إذا اختارتها المستخدمة فهي ليست نعم ولا لا — الحقيقة تبقى غير مؤكدة. أعيدي التقييم وقرري بنفسك: هل يكفي الدليل الآخر للحكم، أم تسألين بطريقة أبسط أو عن معلومة أخرى، أم لا يمكن الحكم بأمان. لا تكرري نفس السؤال بصياغات مختلفة بلا فائدة.',
  '',
  'معنى الوسوم التي ترينها بجانب المعلومات (مثل evidence/UNCERTAIN أو user_answer/CERTAIN):',
  '  - user_answer/CERTAIN = قالتها المستخدمة بنفسها في هذه المحادثة — تعتبرينها مؤكدة.',
  '  - evidence أو memory أو غير مؤكدة = معلومة واردة من سياق التطبيق أو مسترجعة، قد تكون قديمة أو غير دقيقة.',
  '',
  'تأكيد حقيقة مادية (Material Fact Confirmation):',
  '  - إلزامي: إذا كان حكمك (ANSWER) سيعتمد مباشرة على حقيقة مادية ركنية — أي الحكم يتوقف عليها ولا يصح بدونها — وكانت موسومة غير مؤكدة (مثل evidence/UNCERTAIN) أو سياقًا مسترجعًا قد يكون قديمًا، فلا تصدري ANSWER قبل تأكيدها. اطلبي تأكيدها أولًا عبر ASK_USER بسؤال نعم/لا بسيط — مثال الأسلوب: «صار تقريبًا يوم من بداية نزول الدم؟».',
  '  - إذا أجابت نعم → الحقيقة تصبح مؤكدة وأعيدي التقييم وتصدرين الحكم. إذا نفت أو صحّحت → خذي التصحيح وأعيدي التقييم.',
  '  - لا تؤكدي أكثر من حقيقة واحدة في الجولة الواحدة. لا تؤكدي ما قالته هي بنفسها مؤخراً. لا تؤكدي معلومات ثانوية أو مساندة لا يتوقف عليها الحكم، حتى لو كانت غير مؤكدة. الحقائق التي أصبحت user_answer/CERTAIN مؤكدة ولا تحتاج تأكيدًا.',
  '',
  'إذا كانت معلومة مادية ناقصة: لا تفترضيها — اسألي سؤالًا توضيحيًا قصيرًا (ASK_USER) بدل حكم شكلي.',
  '',
  'التعامل مع رسائل المستخدمة في المحادثة تراكمي وطبيعي:',
  '  - السؤال الحالي هو آخر سطر للمستخدمة في المحادثة أدناه — والمطلوب الآن هو الرد عليه في ضوء سياق المحادثة الكامل.',
  '  - إذا كانت الرسالة الأخيرة إجابة على سؤال سألتِه لها (مثل «نعم»، «لا»، «ما أدري»، «غير متأكدة»، أو ذكرت تفصيلاً)، فاستوعبي هذه الإجابة لإكمال المسألة المطروحة وأصدري الحكم أو اسألي عما بقي.',
  '  - إذا أجابت المستخدمة بـ«ما أدري» أو «غير متأكدة»، فهذا يعني أن المعلومة مجهولة لديها — فلا تكرري نفس السؤال بصيغة أخرى، بل اعتبري المعلومة مجهولة (كمن لا تعرف عادتها) وأكملي الجواب بالبحث في المصادر عما تحتاجه الحالة وأصدري الحكم المناسب.',
  '  - إذا كانت الرسالة الأخيرة سؤال متابعة مرتبطاً بما سبق (مثل «طيب إذا استمر؟» أو «ليش؟»)، فافهمي الإشارة من سياق المسألة والحكم السابقين وأجيبي عنها.',
  '  - إذا كانت الرسالة الأخيرة مسألة جديدة ومستقلة، فركزي على إجابة المسألة الجديدة ولا تكرري جواب المسألة السابقة.',
  '',
  'أجزاء الجواب (ضعيها في حقول JSON المقابلة):',
  '  - summary: إلزامي عند كل ANSWER — سطر واحد يحمل خلاصة الشرح أو الحكم المباشر. لا تكتبي كلمة «الخلاصة» داخله.',
  '  - explanation: إلزامي عند كل ANSWER — السبب في جملة أو جملتين قصيرتين.',
  '  - practical: إلزامي عندما للحكم أثر عملي — جملة واحدة: ماذا تفعل المستخدمة الآن.',
  '  - understanding: خطوات واقعية قصيرة عندما تفيد التسلسل الزمني (مثل: «عادتج 6 أيام → الدم استمر 12 يوم → ثم انقطع»). لا تعيدي السؤال ولا تخترعي واقعة.',
  '  - visual: عندما يكون للحالة تسلسل زمني أضيفي {"type":"timeline","items":[{"label":"دم","duration":"3 أيام"},...]}. لا ألوان ولا تصميم — معنى فقط.',
  '  - nextAction: خطوة تالية مفيدة مرتبطة بالسياق فقط، لا تجبري كل جواب عليها.',
  '  - message: النص الكامل البسيط للجواب. في الحكم الشخصي اذكري الحكم أولًا، ثم السبب، ثم الأثر العملي.',
  '',
  'واجهة التنفيذ (هذه ليست طريقة تفكير، بل صيغة الإخراج الموحّدة في كل رد):',
  '  - إذا احتجتِ دليلًا جديدًا: {"action":"USE_TOOL","tool":"search_knowledge","query":"نص البحث"}',
  '  - لإجابة نهائية مع الدليل: {"action":"TERMINAL","status":"ANSWER","message":"نص الجواب","evidenceRefs":["معرّف المقطع"],"summary":"...","explanation":"...","practical":"...","label":"hayd","materialFactKeys":["اسم الحقيقة المؤكدة"]}',
  '  - للسؤال التعليمي العام: استخدمي أداة البحث واشرحي ما ورد في الدليل دون تطبيقه على المستخدمة. أرسلي ANSWER مع evidenceRefs ودون label.',
  '  - للحكم الشخصي: عند اكتمال الحقائق المادية ودعم الدليل، أرسلي ANSWER مع label يطابق الحكم: "hayd" أو "istihada" أو "nifas". إذا تعذر التصنيف فاسألي عن حقيقة مؤثرة واحدة.',
  '  - مع كل label أرسلي materialFactKeys: قائمة غير فارغة بأسماء كل الحقائق المادية التي يعتمد عليها الحكم من المعلومات المعروفة. يجب أن تكون قيمها موجودة وموسومة CERTAIN؛ لا تختلقي أسماء أو يقينًا. إن لم تتوفر حقيقة مؤكدة فاختاري ASK_USER أو INSUFFICIENT_EVIDENCE. الشرح التعليمي دون label لا يحتاج هذه القائمة.',
  '  - لطلب معلومة واحدة مؤثرة: {"action":"TERMINAL","status":"ASK_USER","question":"السؤال","factKey":"onset","answerType":"date"}',
  '  - لطلب معلومة واحدة مؤثرة مع خيارات: {"action":"TERMINAL","status":"ASK_USER","question":"السؤال","factKey":"onset","answerType":"single_choice","options":["خيار 1","خيار 2"]}',
  '  - factKey إلزامي مع كل ASK_USER: اسم ثابت ودقيق للحقيقة المطلوبة، بحروف إنجليزية وأرقام وشرطة سفلية، يبدأ بحرف ولا يتجاوز 60 حرفًا. اختاري الاسم بحسب الحقيقة نفسها لا اسمًا عامًا للسؤال، واحتفظي به في materialFactKeys بعد الإجابة. للحقيقة الموجودة استخدمي اسمها نفسه.',
  '  - answerType إلزامي مع كل ASK_USER ويحدد نوع الجواب المتوقع: number لعدد، duration لمدة رقمية، date لتاريخ، time لوقت على الساعة، yes_no لنعم/لا، single_choice أو multiple_choice لخيارات محددة في options، وfree_text فقط لوصف مفتوح. استخدمي النوع المحدد للعدد أو التاريخ أو الوقت واذكري نوع الخيارات.',
  '  - لطلب تأكيد حقيقة مادية (سؤال جوابه نعم/لا): {"action":"TERMINAL","status":"ASK_USER","question":"السؤال","yesNo":true,"factKey":"onset","answerType":"yes_no"}. نعم ولا و«غير متأكدة» تظهر تلقائيًا.',
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
  /** True when this ASK_USER is a yes/no material-fact confirmation. */
  yesNo?: boolean;
  /** Stable material fact key for any ASK_USER, including a new clarification. */
  factKey?: string;
  /** Explicit expected-answer contract for this named material fact. */
  answerType?: InteractionType;
  /** Short answer choices the user can tap instead of typing (bounded). */
  options?: string[];
  evidenceRefs?: string[];
  /** Required for personal labels; validated against input facts, never model certainty. */
  materialFactKeys?: string[];
  // RX1 semantic parts (all optional; the LLM decides what genuinely helps).
  understanding?: string;
  summary?: string;
  explanation?: string;
  practical?: string;
  visual?: MinimalVisual;
  nextAction?: string;
  /** Stage 4C.6: the ruling classification the client consumes as decisionLabel. */
  label?: 'hayd' | 'istihada' | 'nifas';
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
  const status = str(o.status).toUpperCase().replace(/[\s-]/g, '_');
  const hasLabel = Object.hasOwn(o, 'label');
  const hasMaterialFactKeys = Object.hasOwn(o, 'materialFactKeys');
  if ((hasLabel || hasMaterialFactKeys)
    && (status !== 'ANSWER' || (Object.hasOwn(o, 'action') && action !== 'TERMINAL'))) return null;
  if (action === 'USE_TOOL') {
    const tool = str(o.tool);
    const query = normalizeQuery(str(o.query));
    if (tool !== 'search_knowledge' || !query) return null;
    return { action: 'USE_TOOL', tool: 'search_knowledge', query: bounded(query, 300) };
  }
  if (!['ANSWER', 'ASK_USER', 'INSUFFICIENT_EVIDENCE'].includes(status)) return null;
  const label = str(o.label);
  const validLabel = LABELS.includes(label as typeof LABELS[number]);
  const materialFactKeys = Array.isArray(o.materialFactKeys)
    && o.materialFactKeys.length > 0
    && o.materialFactKeys.length <= 24
    && o.materialFactKeys.every(isFactKey)
    && new Set(o.materialFactKeys).size === o.materialFactKeys.length
    ? o.materialFactKeys
    : undefined;
  // Explicit personal-classification metadata is security-relevant model output. A
  // malformed label/key list cannot be downgraded into apparently educational prose.
  if ((hasLabel && !validLabel) || (hasMaterialFactKeys && (!materialFactKeys || !validLabel))) return null;
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
    ...(o.yesNo === true ? { yesNo: true } : {}),
    ...(isFactKey(o.factKey) ? { factKey: o.factKey } : {}),
    ...(isInteractionType(o.answerType) ? { answerType: o.answerType } : {}),
    ...(Array.isArray(o.options) ? { options: o.options.map((x) => str(x)).filter(Boolean).slice(0, 6) } : {}),
    ...(refs && refs.length > 0 ? { evidenceRefs: refs } : {}),
    ...(materialFactKeys ? { materialFactKeys } : {}),
    ...(str(o.understanding) ? { understanding: bounded(str(o.understanding), 300) } : {}),
    ...(str(o.summary) ? { summary: bounded(str(o.summary), 400) } : {}),
    ...(str(o.explanation) ? { explanation: bounded(str(o.explanation), 800) } : {}),
    ...(str(o.practical) ? { practical: bounded(str(o.practical), 400) } : {}),
    ...(visual ? { visual } : {}),
    ...(str(o.nextAction) ? { nextAction: bounded(str(o.nextAction), 200) } : {}),
    // Stage 4C.6: parse the structural ruling classification; only the three canonical
    // values survive — anything else (or absent) yields NO label (never invented).
    ...(validLabel ? { label: label as MinimalResponse['label'] } : {}),
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
        lastGroundedResult?: {
          skillId?: unknown;
          status?: unknown;
          decision?: unknown;
          explanation?: unknown;
          sourceTitle?: unknown;
          evidenceRefs?: unknown;
          materialFactKeys?: unknown;
          caseSignature?: unknown;
        };
      };
      const text = str(input.text);
      const turns = Array.isArray(input.recentTurns) ? input.recentTurns : [];
      const facts = input.context ?? {};
      const factMeta = input.factMeta ?? {};
      const stored = input.lastGroundedResult;
      const storedLabel = str(stored?.decision);
      const replayFactKeys = Array.isArray(stored?.materialFactKeys)
        && stored.materialFactKeys.length > 0
        && stored.materialFactKeys.length <= 24
        && stored.materialFactKeys.every(isFactKey)
        && new Set(stored.materialFactKeys).size === stored.materialFactKeys.length
        && stored.materialFactKeys.every((key) => isFiqhDecisionMaterialFactKey(key)
          && Object.hasOwn(facts, key)
          && isConfirmedMaterialFact(facts[key], factMeta[key]))
        ? stored.materialFactKeys
        : undefined;
      const replayEvidenceRefs = Array.isArray(stored?.evidenceRefs)
        && stored.evidenceRefs.length > 0
        && stored.evidenceRefs.length <= 6
        && stored.evidenceRefs.every((ref): ref is string => typeof ref === 'string'
          && ref.length > 0 && ref.length <= 64 && ref.trim() === ref)
        ? stored.evidenceRefs
        : undefined;
      if (stored && replayFactKeys && replayEvidenceRefs
        && stored.skillId === MINIMAL_SKILL_ID && stored.status === 'ANSWER'
        && LABELS.includes(storedLabel as typeof LABELS[number])
        && str(stored.caseSignature) && text.length <= 60) {
        const wantsSource = /مصدر|من وين|الدليل|المرجع|مرجعك|دليلك/.test(text);
        const wantsWhy = /ليش|ليه|لماذا|السبب|سبب|وضح|وضّح|فسر|اشرح/.test(text);
        if (wantsSource || wantsWhy) {
          const sourceTitle = bounded(str(stored.sourceTitle) || 'المصدر المعتمد في المشروع', 160);
          const answerText = wantsSource
            ? `المصدر المعتمد: «${sourceTitle}».\nالمقاطع المستشهد بها: ${replayEvidenceRefs.map((ref) => ref.slice(0, 8)).join('، ')}.`
            : (bounded(str(stored.explanation), 700) || 'الحكم مبني على المصدر المعتمد عندي.');
          return {
            status: 'completed',
            answer: {
              text: answerText,
              ...(str(stored.sourceTitle) ? { sourceTitle: bounded(str(stored.sourceTitle), 160) } : {}),
              evidenceIds: replayEvidenceRefs,
              label: storedLabel as typeof LABELS[number],
            },
            trace: {
              status: wantsSource ? 'FOLLOWUP_SOURCE' : 'FOLLOWUP_WHY',
              decisionStatus: 'ANSWER',
              decisionLabel: storedLabel,
              sourceSupport: 'SUPPORTED',
              acceptedEvidenceRefs: replayEvidenceRefs,
              retrievedEvidenceIds: replayEvidenceRefs,
              materialFactKeys: replayFactKeys,
              reusedGroundedResult: true,
              workload: `${WORKLOAD}:followup_answered_from_session_result`,
              notes: [MINIMAL_TRACE_MARKER, `v=${MINIMAL_SKILL_VERSION}`, 'model_calls=0', 'tool_calls=0'],
            },
          };
        }
      }
      // Known facts the user/memory already established — the Mind must NOT re-ask these.
      // Rendered with provenance+certainty so the model can tell a user's own statement
      // from a weaker memory hint. (Calendared Naqaa data has no KIP surface yet — see
      // deferred note; only facts that already reach this payload are shown.)
      const knownLines = Object.entries(facts)
        .filter(([k, v]) => k !== LEGACY_QUESTION_KEY && hasContextValue(v))
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
      /** Stage 4A: one same-turn retry after an unusable provider response (see parser branch). */
      let retriedEmpty = false;
      /** One bounded retry when the model declines evidence it has already received. */
      let retriedEvidenceGap = false;
      /** True only when execution retrieved evidence to repair an initially uncited answer. */
      let recoveredUncitedAnswer = false;
      /** True only when execution retrieved evidence after an initial premature evidence gap. */
      let recoveredInitialEvidenceGap = false;
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
      let interaction = `المحادثة:\n${boundedTail(conversation, MAX_CONVERSATION_CHARS)}${knownBlock}`;

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

      // A final source lookup is allowed only after the bounded model loop has
      // stopped without usable evidence. It is not another model-requested tool
      // call, and it returns an attributed passage rather than a generated ruling.
      let attemptedTerminalSourceLookup = false;
      const terminalSourceExcerpt = async (): Promise<SkillKnowledgePassage | undefined> => {
        const existing = returned.find((passage) => normalizeQuery(passage.text));
        if (existing || attemptedTerminalSourceLookup) return existing;
        attemptedTerminalSourceLookup = true;
        const query = bounded(normalizeQuery(text), MAX_QUESTION_CHARS);
        if (!query) return undefined;
        const hits = await ctx.knowledge!.search({ query, topK: TOOL_TOP_K, sourceIds: approvedIds });
        const sourceExcerpt = hits.find((passage) => passage.sourceId && approvedIds.includes(passage.sourceId) && normalizeQuery(passage.text));
        if (sourceExcerpt && !returned.some((passage) => passage.chunkId === sourceExcerpt.chunkId)) returned.push(sourceExcerpt);
        return sourceExcerpt;
      };

      // 3. ONE intelligence with bounded tool loop.
      for (;;) {
        if (modelCalls >= MAX_MODEL_CALLS) {
          // The model can keep requesting the tool after it has received approved
          // evidence. The bound still stops the loop, but returning that exact passage
          // is safer and more useful than exposing a generic evidence-gap message.
          const sourceExcerpt = await terminalSourceExcerpt();
          if (sourceExcerpt) {
            return {
              status: 'completed',
              answer: {
                text: `بحسب المصدر المعتمد:\n${bounded(sourceExcerpt.text, 900)}`,
                sourceTitle: sourceExcerpt.sourceTitle,
                evidenceIds: [sourceExcerpt.chunkId],
                structured: { summary: 'هذا ما ورد في المصدر المعتمد.' },
              },
              trace: {
                status: 'ANSWER',
                acceptedEvidenceRefs: [sourceExcerpt.chunkId],
                retrievedEvidenceIds: [...returned.map((p) => p.chunkId)],
                evidence: returned.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId })),
                approvedSourceIds: approvedIds,
                sourceSupport: 'SUPPORTED',
                workload: WORKLOAD,
                notes: notes([
                  attemptedTerminalSourceLookup
                    ? 'model_call_bound_terminal_source_lookup'
                    : 'model_call_bound_returned_as_source_excerpt',
                  `queries=${queries.join(' | ')}`,
                ]).slice(0, 8),
              },
            };
          }
          return gap('model_call_bound_reached', 'الدليل المتاح غير كافٍ للحكم الآن.', {
            retrievedEvidenceIds: [...returned.map((p) => p.chunkId)],
            notes: [`queries=${queries.join(' | ')}`],
          });
        }
        modelCalls += 1;
        const out = await ctx.model!.generateText({
          workload: WORKLOAD,
          instructions: MINIMAL_INSTRUCTION,
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
          // Stage 4A: the conversation context is IDENTICAL on every call of this loop
          // (the transcript + current turn live in `interaction`, rebuilt per turn), so a
          // same-turn retry after a successful completion with unusable text loses no context.
          // One bounded retry of the SAME turn only; the loop bound (MAX_MODEL_CALLS)
          // still applies. Only when the turn has made no model progress beyond this call
          // and issued no tool call yet — a later failure stays fail-closed.
          if (modelCalls < MAX_MODEL_CALLS && toolCalls === 0 && !retriedEmpty) {
            retriedEmpty = true;
            continue;
          }
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
          if (!parsed.factKey) {
            return gap('terminal_missing_fact_key', 'تعذّر ترتيب السؤال الآن. حاولي مرة أخرى.', { ...modelName });
          }
          // A stable requirement key lets Conversation bind a new answer or a
          // confirmation to the exact fact later declared by materialFactKeys.
          const key = parsed.factKey;
          if (!parsed.answerType || (parsed.yesNo && parsed.answerType !== 'yes_no')) {
            return gap('terminal_invalid_answer_type', 'تعذّر ترتيب السؤال الآن. حاولي مرة أخرى.', { ...modelName });
          }
          // Answer-effort priority (Stage 4C.7): yes/no → options → free text — the
          // cheapest interaction the fact allows. yes/no confirmations carry options
          // so the client renders نعم | لا | غير متأكدة chips (the yes_no contract
          // accepts booleans and the canonical chip labels). Conversation records
          // «غير متأكدة» with UNKNOWN certainty.
          const askedOptions = Array.isArray(parsed.options) && parsed.options.length > 0
            ? [...new Set([...parsed.options.map((x) => str(x)).filter(Boolean), UNCERTAINTY_OPTION])].slice(0, 7)
            : undefined;
          const categorical = parsed.answerType === 'single_choice' || parsed.answerType === 'multiple_choice';
          if (categorical && !askedOptions) {
            return gap('terminal_missing_options', 'تعذّر ترتيب السؤال الآن. حاولي مرة أخرى.', { ...modelName });
          }
          const interaction = parsed.answerType === 'yes_no'
            ? { type: 'yes_no' as const, options: ['نعم', 'لا', UNCERTAINTY_OPTION] }
            : { type: parsed.answerType, ...(categorical ? { options: askedOptions } : {}) };
          const readiness = deps.readiness.evaluate({
            requirements: [{
              key, description: parsed.question, material: true,
              question: { key, wording: parsed.question },
              interaction,
            }],
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
            // The model sometimes writes a plausible answer before calling the required
            // Knowledge tool. Retrieve once using the current question and let it emit a
            // cited answer (or one clarification question) in the same bounded turn.
            if ((parsed.evidenceRefs?.length ?? 0) === 0 && toolCalls === 0 && modelCalls < MAX_MODEL_CALLS) {
              const query = bounded(normalizeQuery(text), MAX_QUESTION_CHARS);
              if (query) {
                const { rendered } = await askTool(query);
                recoveredUncitedAnswer = true;
                interaction += `\n\nردك السابق لا يحمل مرجعًا صالحًا من المصدر المعتمد.\n${rendered}\nأعيدي الآن ردًا نهائيًا بصيغة TERMINAL: ANSWER مع evidenceRefs من المعرفات الظاهرة فقط، أو ASK_USER بسؤال واحد إذا كانت معلومة مؤثرة ناقصة. لا تخترعي حكمًا ولا تعيدي جوابًا بلا مرجع.`;
                continue;
              }
            }
            // The model has had one citation-recovery attempt but still omitted a valid
            // reference. Do not invent a ruling or present a generic failure when a
            // query-matched approved passage is already available: return that passage
            // transparently as an educational source excerpt.
            const sourceExcerpt = !parsed.label
              ? returned.find((passage) => normalizeQuery(passage.text))
              : undefined;
            // An educational answer can still be useful when the model searched the
            // approved source but omitted citations entirely. Return the retrieved
            // passage itself rather than trust the uncited generation or hide available
            // evidence behind a generic failure. Non-matching citation IDs and personal
            // classifications remain fail-closed.
            if (sourceExcerpt && (recoveredUncitedAnswer || (toolCalls > 0 && (parsed.evidenceRefs?.length ?? 0) === 0))) {
              const excerpt = bounded(sourceExcerpt.text, 900);
              return {
                status: 'completed',
                answer: {
                  text: `بحسب المصدر المعتمد:\n${excerpt}`,
                  sourceTitle: sourceExcerpt.sourceTitle,
                  evidenceIds: [sourceExcerpt.chunkId],
                  structured: { summary: 'هذا ما ورد في المصدر المعتمد.' },
                },
                trace: {
                  ...modelName,
                  status: 'ANSWER',
                  acceptedEvidenceRefs: [sourceExcerpt.chunkId],
                  retrievedEvidenceIds: [...returnedIds],
                  evidence: returned.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId })),
                  approvedSourceIds: approvedIds,
                  sourceSupport: 'SUPPORTED',
                  workload: WORKLOAD,
                  notes: notes([
                    recoveredUncitedAnswer
                      ? 'uncited_answer_returned_as_source_excerpt'
                      : 'post_search_uncited_answer_returned_as_source_excerpt',
                    `queries=${queries.join(' | ')}`,
                  ]).slice(0, 8),
                },
              };
            }
            return gap('answer_without_tool_evidence', 'الدليل المتاح غير كافٍ للحكم الآن.', {
              ...modelName,
              retrievedEvidenceIds: [...returnedIds],
              notes: [`queries=${queries.join(' | ')}`],
            });
          }
          if (parsed.label && (!parsed.materialFactKeys?.length || !parsed.materialFactKeys.every((key) =>
            isFiqhDecisionMaterialFactKey(key)
              && Object.hasOwn(facts, key)
              && isConfirmedMaterialFact(facts[key], factMeta[key]),
          ))) {
            return gap('personal_facts_unconfirmed', 'المعلومات المؤكدة غير كافية للحكم الآن.', { ...modelName });
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
              // Stage 4C.6: the structural ruling classification rides the SAME answer
              // object (SkillAnswer.label) so it reaches ConversationResponse and the
              // proxy's decisionLabel without any later prose-derived guess.
              ...(parsed.label ? { label: parsed.label } : {}),
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
              ...(parsed.label ? {
                decisionStatus: 'ANSWER',
                decisionLabel: parsed.label,
                materialFactKeys: parsed.materialFactKeys,
              } : {}),
              workload: WORKLOAD,
              notes: notes([`queries=${queries.join(' | ')}`]).slice(0, 8),
            },
          };
        }

        // A model can occasionally terminate with an evidence gap before it has made the
        // required source lookup. Recover once at the execution boundary: retrieve using
        // the user's current question, show the result to the same model, and let it make
        // a grounded decision. This keeps the existing provider/model setup intact and
        // still preserves an explicit evidence-gap result after a real lookup.
        if (parsed.status === 'INSUFFICIENT_EVIDENCE' && toolCalls === 0 && modelCalls < MAX_MODEL_CALLS) {
          const query = bounded(normalizeQuery(text), MAX_QUESTION_CHARS);
          if (query) {
            const { rendered } = await askTool(query);
            recoveredInitialEvidenceGap = true;
            interaction += `\n\nلم تُجرِ بحثًا في المصدر المعتمد بعد. هذا البحث مطلوب قبل تقرير أن الدليل غير كافٍ.\n${rendered}\nأعيدي الآن ردًا نهائيًا بصيغة TERMINAL مستندًا فقط إلى المقاطع الظاهرة، أو اطلبي معلومة مؤثرة من المستخدمة.`;
            continue;
          }
        }

        // Once an approved passage is available, the safe useful outcome is either a
        // source-grounded educational answer or one material clarification question.
        // Give the model one explicit chance to choose one of those outcomes instead of
        // exposing a generic evidence-gap message to the user. A second refusal remains
        // fail-closed below; no ruling is created by this recovery path.
        if (parsed.status === 'INSUFFICIENT_EVIDENCE' && returned.length > 0 && !retriedEvidenceGap && modelCalls < MAX_MODEL_CALLS) {
          retriedEvidenceGap = true;
          interaction += '\n\nتوجد الآن مقاطع معتمدة ظاهرة لك. لا تعيدي INSUFFICIENT_EVIDENCE في هذا الرد. إن كان السؤال تعليميًا، أرسلي TERMINAL ANSWER واستشهدي بمقطع ظاهر. وإن كانت معلومة مؤثرة ناقصة للحكم الشخصي، أرسلي TERMINAL ASK_USER بسؤال واحد فقط عن تلك المعلومة. لا تخترعي حكمًا ولا تطلبي بحثًا جديدًا.';
          continue;
        }

        // A source was retrieved only because the model prematurely declined to search,
        // then declined that source again. Show the matched source transparently rather
        // than fabricate a ruling or return a generic failure. This never applies to a
        // model-initiated search, whose ordinary fail-closed gap remains below.
        const sourceExcerpt = recoveredInitialEvidenceGap
          ? returned.find((passage) => normalizeQuery(passage.text))
          : undefined;
        if (sourceExcerpt) {
          return {
            status: 'completed',
            answer: {
              text: `بحسب المصدر المعتمد:\n${bounded(sourceExcerpt.text, 900)}`,
              sourceTitle: sourceExcerpt.sourceTitle,
              evidenceIds: [sourceExcerpt.chunkId],
              structured: { summary: 'هذا ما ورد في المصدر المعتمد.' },
            },
            trace: {
              ...modelName,
              status: 'ANSWER',
              acceptedEvidenceRefs: [sourceExcerpt.chunkId],
              retrievedEvidenceIds: [...returned.map((p) => p.chunkId)],
              evidence: returned.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId })),
              approvedSourceIds: approvedIds,
              sourceSupport: 'SUPPORTED',
              workload: WORKLOAD,
              notes: notes(['initial_evidence_gap_returned_as_source_excerpt', `queries=${queries.join(' | ')}`]).slice(0, 8),
            },
          };
        }

        // INSUFFICIENT_EVIDENCE
        return gap('mind_reported_insufficient_evidence', FIQH_EVIDENCE_GAP_MESSAGE, {
          ...modelName,
          retrievedEvidenceIds: [...returned.map((p) => p.chunkId)],
          notes: [`queries=${queries.join(' | ')}`],
        });
      }
    },
  };
}
