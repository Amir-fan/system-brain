import { useState } from 'react';
import { BookOpen, Plus } from 'lucide-react';
import { useI18n } from '../i18n';
import { Card, CardHeader, Button } from '../ui/primitives';
import { ProviderGrid } from './Providers';
import { ModelAssignment } from './ModelAssignment';
import { UsageCosts } from './UsageCosts';
import { RecentActivity } from './RecentActivity';
import {
  demoProviders,
  demoWorkloads,
  modelOptions,
  demoUsageStats,
  demoChart,
  demoActivity,
} from '../data/demo';

const TABS = [
  { key: 'tab.overview' },
  { key: 'tab.providers' },
  { key: 'tab.assignment' },
  { key: 'tab.usage' },
  { key: 'tab.settings' },
] as const;

export function AIAndModels() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState(0);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      {/* Page header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t('page.title')}</h1>
          <p className="mt-1.5 max-w-xl text-sm text-muted">{t('page.subtitle')}</p>
        </div>
        <Button variant="ghost">
          <BookOpen className="h-4 w-4" /> {t('page.docs')}
        </Button>
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-6 border-b border-surface-line">
        {TABS.map((tb, i) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setActiveTab(i)}
            className={`relative pb-3 text-sm font-medium transition ${
              i === activeTab ? 'text-brand-700' : 'text-muted hover:text-slate-800'
            }`}
          >
            {t(tb.key)}
            {i === activeTab ? (
              <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-brand-600" />
            ) : null}
          </button>
        ))}
      </div>

      {/* Tab content — all four sections on Overview, mirroring the reference dashboard */}
      <div className="mt-8 space-y-6">
        {activeTab === 0 && (
          <>
            {/* AI Providers */}
            <Card>
              <CardHeader
                title={t('providers.title')}
                subtitle={t('providers.subtitle')}
                action={
                  <Button variant="primary">
                    <Plus className="h-4 w-4" /> {t('providers.add')}
                  </Button>
                }
              />
              <ProviderGrid providers={demoProviders} />
            </Card>

            {/* Model Assignment */}
            <ModelAssignment
              assignments={Object.fromEntries(demoWorkloads.map((w) => [w.workloadKey, { model: w.modelId, recommended: w.recommended }])) as Record<
                import('../contracts/models').WorkloadKey,
                { model: string; recommended: boolean }
              >}
              models={modelOptions}
              onChange={(_k, _m) => {
                /* UI-only: persists once wired to backend */
              }}
              onSave={() => {
                /* UI-only */
              }}
            />

            {/* Usage & Costs */}
            <UsageCosts stats={demoUsageStats} chart={demoChart} />

            {/* Recent Activity */}
            <RecentActivity events={demoActivity} />
          </>
        )}

        {activeTab >= 1 && activeTab <= 4 && (
          <Card className="p-6 text-center text-muted-soft">
            <div className="mx-auto max-w-sm py-10">
              <div className="text-sm">{t(TABS[activeTab].key)}</div>
              <p className="mt-2 text-sm text-muted">(قريبًا — تجريبي)</p>
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}