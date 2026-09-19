import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import { FileSearch, MessageCircle, ScanLine, ListChecks, BarChart3, MessageSquareText } from 'lucide-react';
import type { WorkloadKey } from '../contracts/models';
import { useI18n } from '../i18n';
import { Button, Card, CardHeader } from '../ui/primitives';
import {
  listModelAssignments,
  putModelAssignment,
  deleteModelAssignment,
  fetchModelCatalog,
} from '../api/model-assignments';
import type { AdminAssignment, CatalogModel } from '../api/model-assignments';

const ICONS: Record<WorkloadKey, typeof FileSearch> = {
  source_analysis: FileSearch,
  chat_assistant: MessageCircle,
  vision_scan: ScanLine,
  summarization: ListChecks,
  embeddings: BarChart3,
  knowledge_answer: MessageSquareText,
};

const DESCRIPTIONS: Record<WorkloadKey, string> = {
  source_analysis: 'workload.desc.source_analysis',
  chat_assistant: 'workload.desc.chat_assistant',
  vision_scan: 'workload.desc.vision_scan',
  summarization: 'workload.desc.summarization',
  embeddings: 'workload.desc.embeddings',
  knowledge_answer: 'workload.desc.knowledge_answer',
};

const ORDER: WorkloadKey[] = ['source_analysis', 'chat_assistant', 'vision_scan', 'summarization', 'embeddings', 'knowledge_answer'];

export function ModelAssignment() {
  const { t } = useI18n();
  const [assignments, setAssignments] = useState<Record<WorkloadKey, string>>({} as Record<WorkloadKey, string>);
  const [draft, setDraft] = useState<Record<WorkloadKey, string>>({} as Record<WorkloadKey, string>);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<WorkloadKey | null>(null);
  const [savedKey, setSavedKey] = useState<WorkloadKey | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);

  const modelMap = useMemo(() => new Map(catalog.map((m) => [m.id, m])), [catalog]);

  useEffect(() => {
    (async () => {
      try {
        const [ass, cat] = await Promise.all([listModelAssignments(), fetchModelCatalog()]);
        const a = {} as Record<WorkloadKey, string>;
        const d = {} as Record<WorkloadKey, string>;
        for (const w of ORDER) {
          const found = ass.find((x) => x.workloadKey === w);
          a[w] = found?.modelId ?? '';
          d[w] = found?.modelId ?? '';
        }
        setAssignments(a);
        setDraft(d);
        setCatalog(cat.models);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load');
        setCatalogNotice(t('assignment.catalogUnavailable'));
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const save = async (w: WorkloadKey) => {
    const modelId = draft[w];
    if (!modelId) return; // empty selection = not changing
    setSaving(w);
    setError(null);
    setSavedKey(null);
    try {
      const saved = await putModelAssignment(w, modelId);
      setAssignments((p) => ({ ...p, [w]: saved.modelId }));
      setSavedKey(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(null);
    }
  };

  const clearAssignment = async (w: WorkloadKey) => {
    setSaving(w);
    setError(null);
    try {
      await deleteModelAssignment(w);
      setAssignments((p) => ({ ...p, [w]: '' }));
      setDraft((p) => ({ ...p, [w]: '' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clear failed');
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader title={t('assignment.title')} subtitle={t('assignment.subtitle')} />
      <div className="px-6 pb-4 pt-1">
        {catalogNotice ? <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{catalogNotice}</p> : null}
        {error ? <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</p> : null}

        {loading ? (
          <div className="py-10 text-center text-sm text-muted-soft">{t('assignment.loading')}</div>
        ) : (
          <ul className="divide-y divide-surface-line">
            {ORDER.map((wk) => {
              const Icon = ICONS[wk];
              const current = assignments[wk];
              const modelId = draft[wk];
              const isSaving = saving === wk;
              return (
                <li key={wk} className="flex flex-wrap items-center justify-between gap-3 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-800">{t(`workload.${wk}`)}</span>
                        <span dir="ltr" className="text-[11px] text-muted-soft">{wk}</span>
                        {savedKey === wk ? <span className="text-xs text-success-700">{t('assignment.saved')}</span> : null}
                      </div>
                      <p className="text-xs text-muted-soft">{t(DESCRIPTIONS[wk])}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      aria-label={t(`workload.${wk}`)}
                      value={catalog.some((c) => c.id === modelId) ? modelId : ''}
                      disabled={catalog.length === 0}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => setDraft((p) => ({ ...p, [wk]: e.target.value }))}
                      className="max-w-[260px] rounded-lg border border-surface-line bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none focus:border-brand-400 disabled:opacity-50"
                    >
                      <option value="">{t('assignment.selectModel')}</option>
                      {catalog.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.id}
                        </option>
                      ))}
                    </select>

                    <Button
                      variant={current ? 'primary' : 'outline'}
                      disabled={isSaving || !modelId}
                      onClick={() => save(wk)}
                      title={current ? t('assignment.saveChanges') : t('assignment.save')}
                    >
                      {isSaving ? t('assignment.saving') : t('assignment.save')}
                    </Button>

                    {current ? (
                      <Button variant="ghost" disabled={isSaving} onClick={() => clearAssignment(wk)}>
                        {t('assignment.clear')}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}