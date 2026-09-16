import { useEffect, useMemo, useState } from 'react';
import { useProjectContext } from '../contexts/ProjectContext';
import { useI18n } from '../i18n';
import { Card, Button } from '../ui/primitives';
import { conversationApi } from '../api/conversation';
import type {
  ConversationMode,
  ConversationResponse,
  ConversationTurnStatus,
  InteractionSpec,
  InteractionType,
  EvaluationListItem,
  SkillListItem,
} from '../api/conversation';

const PROGRESS_TXT: Record<string, string> = {
  UNDERSTANDING: 'نفهم السؤال…',
  CONTEXT_RETRIEVAL: 'نجمع المعلومات المرتبطة بالحالة…',
  CHECKING_READINESS: 'نتأكد إن المعلومات المهمة مكتملة…',
  EXECUTING_SKILL: 'نحلل الحالة…',
  PREPARING_RESPONSE: 'نرتب الجواب…',
};

const STATUS_TXT: Record<ConversationTurnStatus, string> = {
  completed: 'مكتمل',
  needs_information: 'يحتاج معلومة',
  insufficient_context: 'سياق غير كافٍ',
  needs_clarification: 'يحتاج توضيحًا',
  failed: 'فشل',
};

interface Msg {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  interaction?: InteractionSpec;
  stages?: string[];
  runId?: string;
  status?: ConversationTurnStatus;
  understanding?: ConversationResponse['understanding'];
  readiness?: ConversationResponse['readiness'];
  trace?: ConversationResponse['trace'];
}

/**
 * Wraps a structured control with the question it answers, so the tester never
 * faces an unlabeled input: QUESTION / LABEL + CONTROL.
 */
function Control({
  interaction,
  showQuestion = true,
  children,
}: {
  interaction: InteractionSpec;
  showQuestion?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {showQuestion && interaction.question ? (
        <p className="text-xs font-medium text-slate-700" dir="auto">{interaction.question}</p>
      ) : null}
      {children}
    </div>
  );
}

function InteractionComposer({
  interaction,
  onSend,
  submitting,
  showQuestion = true,
}: {
  interaction: InteractionSpec;
  onSend: (value: { key: string; value: unknown; text: string }) => void;
  submitting?: boolean;
  /** The question is always shown next to its control (never a naked input). */
  showQuestion?: boolean;
}) {
  const [input, setInput] = useState('');
  const [showOther, setShowOther] = useState(false);

  const sub = (value: unknown, text = '') => {
    onSend({ key: interaction.key, value, text: text || interaction.question });
    setShowOther(false);
    setInput('');
  };

  const submitText = () => {
    if (!input.trim()) return;
    switch (interaction.type) {
      case 'number':
      case 'duration':
        sub(Number(input), input);
        break;
      case 'date':
        sub(input, input);
        break;
      default:
        sub(input, input);
    }
  };

  if (interaction.type === 'yes_no') {
    return (
      <Control interaction={interaction} showQuestion={showQuestion}>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={submitting} onClick={() => sub(true, 'نعم')}>نعم</Button>
          <Button variant="outline" disabled={submitting} onClick={() => sub(false, 'لا')}>لا</Button>
        </div>
      </Control>
    );
  }

  if (interaction.type === 'single_choice' && interaction.options && interaction.options.length > 0) {
    return (
      <Control interaction={interaction} showQuestion={showQuestion}>
        <div className="flex flex-wrap items-center gap-2">
          {interaction.options.map((opt) => (
            <Button key={opt} variant="outline" disabled={submitting} onClick={() => sub(opt, opt)}>
              {opt}
            </Button>
          ))}
          {interaction.allowOther ? (
            showOther ? (
              <input
                autoFocus
                value={input}
                onKeyDown={(e) => e.key === 'Enter' && submitText()}
                onChange={(e) => setInput(e.target.value)}
                onBlur={() => input.trim() && submitText()}
                className="w-40 rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
              />
            ) : (
              <Button variant="ghost" onClick={() => setShowOther(true)}>أخرى…</Button>
            )
          ) : null}
        </div>
      </Control>
    );
  }

  const isNumeric = interaction.type === 'number' || interaction.type === 'duration';
  return (
    <Control interaction={interaction} showQuestion={showQuestion}>
      <div className="flex items-center gap-2">
        <input
          value={input}
          type={interaction.type === 'date' ? 'date' : isNumeric ? 'number' : 'text'}
          placeholder={interaction.type === 'free_text' ? 'اكتب …' : isNumeric ? 'أدخل قيمة' : 'أدخل التاريخ'}
          onKeyDown={(e) => e.key === 'Enter' && submitText()}
          onChange={(e) => setInput(e.target.value)}
          className="w-56 rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
        />
        <Button variant="primary" disabled={submitting || !input.trim()} onClick={submitText}>إرسال</Button>
      </div>
    </Control>
  );
}

export function TestsConsole() {
  const { t } = useI18n();
  const { activeProject } = useProjectContext();

  const [mode, setMode] = useState<ConversationMode>('contextual');
  const [started, setStarted] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const [evalState, setEvalState] = useState<{ isCorrect: boolean; saved: boolean } | null>(null);
  const [evalCategory, setEvalCategory] = useState<string>('');
  const [evalNote, setEvalNote] = useState<string>('');
  const [evaluations, setEvaluations] = useState<EvaluationListItem[]>([]);
  // Which registered skill the test drives (the conversation default is the demo
  // fixture; a domain skill such as naqaa.fiqh-hayd is chosen explicitly here).
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [skillId, setSkillId] = useState<string>('');

  useEffect(() => {
    if (!activeProject) return;
    conversationApi.listEvaluations(activeProject.id).then(setEvaluations).catch(() => {});
    conversationApi.listSkills(activeProject.id).then(setSkills).catch(() => {});
  }, [activeProject]);

  const lastAssistant = useMemo<Msg | null>(() => {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') return msgs[i];
    return null;
  }, [msgs]);

  // The newest turn is rendered live (its control stays interactive); history is
  // everything before it. If the newest message is still an in-flight user turn,
  // render no live block (the user bubble must not disappear).
  const liveMsg = msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant' ? msgs[msgs.length - 1] : null;
  const history = liveMsg ? msgs.slice(0, -1) : msgs;
  // The question is rendered exactly once: in the bubble, or — when the turn IS
  // just a structured question — as the control's own label.
  const liveText = (liveMsg?.text ?? '').trim();
  const liveQuestion = liveMsg?.interaction?.question ?? '';
  const showLiveBubble = liveText.length > 0 && liveText !== liveQuestion;

  const projectId = activeProject?.id;

  const startConversation = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const created = await conversationApi.createConversation(projectId, mode);
      setConversationId(created.id);
      setStarted(true);
      setMsgs([]);
      setEvalState(null);
      setEvalCategory('');
      setEvalNote('');
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: e instanceof Error ? e.message : 'تعذر بدء المحادثة.', at: '' }]);
    } finally {
      setBusy(false);
    }
  };

  const send = async (text: string, answers?: Array<{ key: string; value: unknown }>) => {
    if (!projectId || !conversationId || !text.trim()) return;
    const clean = text.trim();
    setDraft('');
    setBusy(true);
    setMsgs((m) => [...m, { role: 'user', text: clean, at: '' }]);
    try {
      const res = await conversationApi.sendMessage(projectId, conversationId, {
        text: clean,
        ...(answers ? { answers } : {}),
        ...(skillId ? { skillId } : {}),
      });
      setMsgs((m) => [
        ...m,
        {
          role: 'assistant',
          text: res.message,
          at: '',
          interaction: res.interaction,
          stages: res.stages,
          runId: res.runId,
          status: res.status,
          understanding: res.understanding,
          readiness: res.readiness,
          trace: res.trace,
        },
      ]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: e instanceof Error ? e.message : 'تعذر إرسال الرسالة.', at: '' }]);
    } finally {
      setBusy(false);
    }
  };

  const onInteraction = (v: { key: string; value: unknown; text: string }) => {
    void send(v.text, [{ key: v.key, value: v.value }]);
  };

  const submitEvaluation = async () => {
    if (!projectId || !conversationId || !evalState) return;
    if (evalState.isCorrect === false && !evalCategory) return;
    try {
      await conversationApi.saveEvaluation(projectId, conversationId, {
        isCorrect: evalState.isCorrect,
        ...(evalState.isCorrect === false ? { problemCategory: evalCategory as never } : {}),
        ...(evalNote.trim() ? { note: evalNote.trim() } : {}),
      });
      setEvalState({ ...evalState, saved: true });
      conversationApi.listEvaluations(projectId).then(setEvaluations).catch(() => {});
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', text: e instanceof Error ? e.message : 'تعذر حفظ التقييم.', at: '' }]);
    }
  };

  if (!projectId) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-8">
        <Card className="p-10 text-center">
          <div className="text-lg font-semibold text-slate-800">اختبارات العقل</div>
          <p className="mt-2 text-sm text-muted">اختر مشروعًا لبدء اختبار المحادثة.</p>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">اختبارات العقل</h1>
          <p className="mt-1.5 max-w-xl text-sm text-muted">
            تجربة محادثة حقيقية مع KIP داخل المشروع: {activeProject.name}
          </p>
        </div>
        <Button variant="ghost" disabled={!started} onClick={() => setShowTrace((s) => !s)}>
          {showTrace ? 'إخفاء تفاصيل الاختبار' : 'عرض تفاصيل الاختبار'}
        </Button>
      </div>

      {/* Mode + start */}
      {!started ? (
        <Card className="mt-6 p-6">
          <div className="text-sm font-semibold text-slate-700">نوع المحادثة</div>
          <div className="mt-3 flex gap-2">
            <Button variant={mode === 'contextual' ? 'primary' : 'outline'} onClick={() => setMode('contextual')}>سياقي</Button>
            <Button variant={mode === 'private' ? 'primary' : 'outline'} onClick={() => setMode('private')}>خاص</Button>
          </div>
          <div className="mt-2 text-xs text-muted-soft">
            {mode === 'contextual'
              ? 'يقرأ الذكاء سياق المستخدم الشخصي (الذاكرة) عند الحاجة.'
              : 'معزول عن الذاكرة الشخصية — لا يقرأ ولا يكتب فيها.'}
          </div>
          {skills.length > 1 ? (
            <div className="mt-5">
              <div className="text-sm font-semibold text-slate-700">المهارة المُختبرة</div>
              <select
                className="mt-2 w-full max-w-sm rounded-lg border border-surface-line bg-white px-3 py-2 text-sm text-slate-700"
                value={skillId || skills[0].id}
                onChange={(e) => setSkillId(e.target.value)}
                dir="ltr"
              >
                {skills.map((sk) => (
                  <option key={sk.id} value={sk.id}>
                    {sk.id}{sk.requirements?.knowledge ? ' · مصادر معتمدة' : ''}
                  </option>
                ))}
              </select>
              <div className="mt-2 text-xs text-muted-soft" dir="auto">
                {skills.find((sk) => sk.id === (skillId || skills[0].id))?.description ?? ''}
              </div>
            </div>
          ) : null}
          <Button variant="primary" disabled={busy} className="mt-4" onClick={startConversation}>
            {busy ? 'جارٍ البدء…' : 'محادثة جديدة'}
          </Button>
        </Card>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-3 text-xs text-muted-soft">
            <span>
              الوضع: <b className="text-slate-700">{mode === 'contextual' ? 'سياقي' : 'خاص'}</b>
            </span>
            <span>·</span>
            <span>
              حالة آخر رد: <b className="text-slate-700">{lastAssistant ? (STATUS_TXT[lastAssistant.status ?? 'failed'] ?? lastAssistant.status) : '—'}</b>
            </span>
            {lastAssistant?.runId ? (
              <>
                <span>·</span>
                <span dir="ltr" className="font-mono text-[11px]">{lastAssistant.runId.slice(0, 8)}…</span>
              </>
            ) : null}
            <span className="ms-auto">
              <Button variant="ghost" onClick={() => { setStarted(false); setConversationId(null); setMsgs([]); }}>
                إنهاء وإغلاق
              </Button>
            </span>
          </div>

          <Card className="mt-4 space-y-4 p-5">
            {msgs.length === 0 ? (
              <div className="py-14 text-center text-sm text-muted-soft">ابدا محادثة… اكتب رسالتك أدناه.</div>
            ) : (
              history.map((m, i) => (
                <div key={i}>
                  {m.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2.5 text-sm text-white" dir="auto">{m.text}</div>
                    </div>
                  ) : (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] space-y-2">
                        <div className="rounded-2xl rounded-bl-sm border border-surface-line bg-white px-4 py-2.5 text-sm text-slate-800" dir="auto">{m.text}</div>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}

            {/* Newest assistant turn — its structured control stays live. */}
            {liveMsg ? (
              <div className="space-y-2">
                {showLiveBubble ? (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] space-y-2">
                      <div className="rounded-2xl rounded-bl-sm border border-surface-line bg-white px-4 py-2.5 text-sm text-slate-800" dir="auto">
                        {liveText}
                      </div>
                    </div>
                  </div>
                ) : null}
                {liveMsg.stages && liveMsg.stages.length > 0 ? (
                  <div className="flex flex-wrap gap-1 ps-1">
                    {liveMsg.stages.map((s) => (
                      <span key={s} className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted-soft">{PROGRESS_TXT[s] ?? s}</span>
                    ))}
                  </div>
                ) : null}
                {liveMsg.interaction ? (
                  <InteractionComposer interaction={liveMsg.interaction} submitting={busy} onSend={onInteraction} />
                ) : null}
              </div>
            ) : null}
          </Card>

          {/* Footer input */}
          <div className="mt-4">
            <input
              value={draft}
              placeholder="اكتب رسالتك…"
              disabled={busy}
              onKeyDown={(e) => e.key === 'Enter' && send(draft)}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full rounded-xl border border-surface-line bg-white px-4 py-3 text-sm outline-none focus:border-brand-400"
            />
          </div>
        </>
      )}

      {/* Feedback */}
      {started && lastAssistant && lastAssistant.status !== 'needs_information' ? (
        <Card className="mt-6 p-5">
          <div className="text-sm font-semibold text-slate-700">هل النتيجة صحيحة؟</div>
          <div className="mt-2 flex gap-2">
            <Button variant={evalState?.isCorrect === true ? 'primary' : 'outline'} onClick={() => setEvalState({ isCorrect: true, saved: false })}>صحيحة</Button>
            <Button variant={evalState?.isCorrect === false ? 'primary' : 'outline'} onClick={() => setEvalState({ isCorrect: false, saved: false })}>خاطئة</Button>
          </div>
          {evalState?.isCorrect === false ? (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-2">
                {['understanding', 'clarification', 'context', 'source', 'result', 'wording', 'other'].map((c) => (
                  <Button key={c} variant={evalCategory === c ? 'primary' : 'outline'} onClick={() => setEvalCategory(c)}>
                    {c}
                  </Button>
                ))}
              </div>
              <input
                value={evalNote}
                placeholder="ملاحظة قصيرة (اختياري)"
                onChange={(e) => setEvalNote(e.target.value)}
                className="w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
              />
            </div>
          ) : null}
          {evalState && (
            <Button variant="primary" className="mt-3" disabled={evalState.saved} onClick={submitEvaluation}>
              {evalState.saved ? 'تم الحفظ' : 'حفظ التقييم'}
            </Button>
          )}
        </Card>
      ) : null}

      {/* Trace drawer */}
      {showTrace && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setShowTrace(false)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-white p-6 shadow-xl" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">تفاصيل الاختبار</h3>
              <Button variant="ghost" onClick={() => setShowTrace(false)}>إغلاق</Button>
            </div>
            <div className="mt-4 space-y-4 text-sm">
              <TraceSection title="العملية">
                <Row k="run id" v={lastAssistant?.runId ?? '—'} />
                <Row k="Status" v={lastAssistant?.status ?? '—'} />
                <Row k="المراحل الفعلية" v={lastAssistant?.stages?.join(' → ') ?? '—'} />
              </TraceSection>
              <TraceSection title="الفهم">
                <Row k="dialogue act" v={lastAssistant?.understanding?.dialogueAct ?? '—'} />
                <Row k="understanding" v={lastAssistant?.understanding?.status ?? '—'} />
              </TraceSection>
              <TraceSection title="الاستعداد">
                <Row k="readiness" v={lastAssistant?.readiness?.status ?? '—'} />
                {lastAssistant?.readiness?.missingKeys?.length ? (
                  <Row k="مفتاح ناقص" v={lastAssistant.readiness.missingKeys.join('، ')} />
                ) : null}
              </TraceSection>
              {lastAssistant?.trace ? (
                <TraceSection title="المسألة والمصادر">
                  <Row k="المسألة" v={lastAssistant.trace.issue ?? '—'} />
                  <Row k="حالة المهارة" v={lastAssistant.trace.status ?? '—'} />
                  <Row k="مصادر معتمدة" v={lastAssistant.trace.approvedSourceIds?.length ? lastAssistant.trace.approvedSourceIds.join('، ') : '—'} />
                  <Row k="مقاطع مستشهد بها" v={lastAssistant.trace.evidence?.length ? lastAssistant.trace.evidence.map((e) => e.chunkId).join('، ') : '—'} />
                  <Row k="متطلبات مشتقة" v={lastAssistant.trace.requirementKeys?.length ? lastAssistant.trace.requirementKeys.join('، ') : '—'} />
                  {lastAssistant.trace.notes?.length ? <Row k="ملاحظات" v={lastAssistant.trace.notes.join(' · ')} /> : null}
                </TraceSection>
              ) : null}
              <TraceSection title="النتيجة">
                <Row k="interaction" v={lastAssistant?.interaction?.type ?? 'نص حر'} />
                <Row k="المشروع" v={activeProject.name} />
                <Row k="الوضع" v={mode === 'contextual' ? 'سياقي' : 'خاص'} />
              </TraceSection>
              <p className="text-[11px] leading-relaxed text-muted-soft">
                تعرض هنا المشغّلات الحقيقية من وقت الاستجابة فقط؛ لا وصول إلى الذاكرة الشخصية أو سلسلة التفكير.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Recent evaluations (persisted) */}
      {evaluations.length > 0 && (
        <Card className="mt-6 p-5">
          <div className="text-sm font-semibold text-slate-700">التقييمات المحفوظة</div>
          <div className="mt-3 space-y-2">
            {evaluations.map((ev) => (
              <div key={ev.id} className="flex items-center justify-between gap-3 rounded-lg border border-surface-line px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className={`text-base leading-none ${ev.isCorrect ? 'text-success-600' : 'text-rose-500'}`}>
                    {ev.isCorrect ? '✓' : '✕'}
                  </span>
                  <span className="text-muted">
                    {ev.conversationMode === 'private' ? 'خاص' : ev.conversationMode === 'contextual' ? 'سياقي' : '—'}
                  </span>
                  {ev.problemCategory ? (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] text-muted-soft" dir="auto">{ev.problemCategory}</span>
                  ) : null}
                </div>
                <span className="text-xs text-muted-soft" dir="ltr">{new Date(ev.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </main>
  );
}

function TraceSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 border-b border-surface-line pb-1 text-xs font-semibold text-brand-700">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  if (!v || v === '—') return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{k}</span>
      <span dir="auto" className="max-w-[60%] truncate text-slate-800">{v}</span>
    </div>
  );
}