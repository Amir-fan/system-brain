import { TrendingUp, TrendingDown } from 'lucide-react';
import type { ChartPoint, UsageStat } from '../contracts/models';
import { useI18n } from '../i18n';
import { Card, CardHeader } from '../ui/primitives';

function StatCard({ stat }: { stat: UsageStat }) {
  const { t } = useI18n();
  const good = stat.direction === stat.trendGood;
  const color = good ? 'text-success-600' : 'text-rose-500';
  const Icon = stat.direction === 'down' ? TrendingDown : TrendingUp;

  return (
    <div className="rounded-xl2 border border-surface-line bg-surface-card p-5 shadow-card">
      <div className="text-sm text-muted">{t(stat.labelI18nKey)}</div>
      <div className="mt-2 text-2xl font-bold tracking-tight text-slate-900">{stat.value}</div>
      <div className={`mt-1 inline-flex items-center gap-1 text-sm font-medium ${color}`}>
        <Icon className="h-4 w-4" />
        {stat.delta}
      </div>
    </div>
  );
}

function LineChart({ points }: { points: ChartPoint[] }) {
  const { t } = useI18n();
  const w = 600;
  const h = 160;
  const pad = 8;
  const max = Math.max(...points.map((p) => p.tokens)) * 1.15;
  const step = (w - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => [pad + i * step, h - pad - (p.tokens / max) * (h - pad * 2)] as const);
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
  const area = `${path} L${coords[coords.length - 1][0].toFixed(1)},${h - pad} L${coords[0][0].toFixed(1)},${h - pad} Z`;
  const hover = points.findIndex((p) => p.tokens === Math.max(...points.map((x) => x.tokens)));

  // highlight a representative mid-range point like the reference tooltip marker
  const marker = coords[hover];
  const labelDt = 'Sep 3';
  const tokensText = t('usage.tokens');

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-44 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="usageArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f5ee0" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#4f5ee0" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#usageArea)" />
        <path d={path} fill="none" stroke="#4f5ee0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={marker[0]} cy={marker[1]} r="4" fill="#4f5ee0" stroke="#fff" strokeWidth="2" />
      </svg>
      {/* axis labels */}
      <div className="mt-1 flex justify-between px-2 text-[11px] text-muted-soft">
        <span>Aug 14</span>
        <span>Sep 11</span>
      </div>
      {/* tooltip */}
      <div
        className="pointer-events-none absolute top-8 rounded-lg border border-surface-line bg-white px-3 py-1.5 text-xs shadow-card"
        style={{
          insetInlineStart: `calc(${((marker[0] / w) * 100).toFixed(0)}% - 40px)`,
        }}
      >
        <div className="font-medium text-slate-700">
          {labelDt} · {tokensText}: {points[hover].tokens.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

function langDate(): string {
  return 'Sep 3';
}

export function UsageCosts({ stats, chart }: { stats: UsageStat[]; chart: ChartPoint[] }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader
        title={t('usage.title')}
        action={
          <div className="flex items-center gap-2 rounded-lg border border-surface-line px-3 py-1.5 text-sm text-muted">
            <span>{t('usage.last30')}</span>
            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
              <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        }
      />
      <div className="px-6 pb-6">
        <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
          {stats.map((s) => (
            <StatCard key={s.labelI18nKey} stat={s} />
          ))}
        </div>
        <LineChart points={chart} />
      </div>
    </Card>
  );
}