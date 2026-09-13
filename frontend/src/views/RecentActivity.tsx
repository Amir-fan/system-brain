import type { ActivityEvent } from '../contracts/models';
import { useI18n } from '../i18n';
import { Badge, Card, CardHeader } from '../ui/primitives';

export function RecentActivity({ events }: { events: ActivityEvent[] }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader
        title={t('activity.title')}
        action={<button className="text-sm font-medium text-brand-600 hover:text-brand-700">{t('activity.viewAll')}</button>}
      />
      <div className="overflow-x-auto px-6 pb-6">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-surface-line text-left">
              {['activity.colTime', 'activity.colAction', 'activity.colProvider', 'activity.colDetails', 'activity.colStatus'].map(
                (k) => (
                  <th key={k} className="pb-3 pe-4 text-xs font-semibold uppercase tracking-wide text-muted-soft">
                    {t(k)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {events.map((ev, i) => (
              <tr key={i} className="border-b border-surface-line last:border-0">
                <td className="whitespace-nowrap py-3 pe-4 text-muted">{t(ev.timeI18nKey)}</td>
                <td className="whitespace-nowrap py-3 pe-4 font-medium text-slate-800">{t(ev.actionI18nKey)}</td>
                <td className="whitespace-nowrap py-3 pe-4 text-muted">{ev.provider}</td>
                <td className="py-3 pe-4 text-muted">{t(ev.detailI18nKey)}</td>
                <td className="py-3">
                  <Badge tone={ev.status === 'success' ? 'success' : 'neutral'}>{t(`status.${ev.status}`)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}