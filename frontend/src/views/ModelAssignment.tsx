import type { ChangeEvent } from 'react';
import { FileSearch, ScanLine, MessageCircle, BarChart3, ListChecks } from 'lucide-react';
import type { WorkloadKey } from '../contracts/models';
import { useI18n } from '../i18n';
import { Badge, Button, Card, CardHeader } from '../ui/primitives';

const ICONS: Record<WorkloadKey, typeof FileSearch> = {
  'source-analysis': FileSearch,
  'smart-scan': ScanLine,
  'chat-assistant': MessageCircle,
  embeddings: BarChart3,
  summarization: ListChecks,
};

const ORDER: WorkloadKey[] = ['source-analysis', 'smart-scan', 'chat-assistant', 'embeddings', 'summarization'];

export interface AssignmentState {
  model: string;
  recommended: boolean;
}

export function ModelAssignment({
  assignments,
  models,
  onChange,
  onSave,
}: {
  assignments: Record<WorkloadKey, AssignmentState>;
  models: string[];
  onChange?: (k: WorkloadKey, model: string) => void;
  onSave?: () => void;
}) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader title={t('assignment.title')} subtitle={t('assignment.subtitle')} />
      <div className="px-6 pb-4">
        <ul className="divide-y divide-surface-line">
          {ORDER.map((wk) => {
            const a = assignments[wk];
            const Icon = ICONS[wk];
            return (
              <li key={wk} className="flex items-center justify-between gap-4 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{t(`workload.${wk}`)}</span>
                    {a.recommended ? <Badge tone="success">✓ {t('assignment.recommended')}</Badge> : null}
                  </div>
                </div>
                <select
                  aria-label={t(`workload.${wk}`)}
                  value={a.model}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange?.(wk, e.target.value)}
                  className="rounded-lg border border-surface-line bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none focus:border-brand-400"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onSave}>
            {t('assignment.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}