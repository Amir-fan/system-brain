import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Plug, EyeOff, CheckCircle2, Circle, Trash2 } from 'lucide-react';
import type { AiProvider } from '../contracts/models';
import { useI18n } from '../i18n';
import { Badge, Button } from '../ui/primitives';
import {
  connectOpenRouter,
  testOpenRouter,
  revokeOpenRouter,
  listOpenRouter,
  listOpenRouterModels,
} from '../api/providers';
import type { ProviderPublic } from '../api/providers';

function ProviderStatus({ provider, live }: { provider: AiProvider; live?: ProviderPublic }) {
  const { t } = useI18n();
  const connected = live?.connectionStatus === 'connected' || (live?.connectionStatus === undefined && provider.status === 'connected');
  return connected ? (
    <Badge tone="success">
      <span className="h-1.5 w-1.5 rounded-full bg-success-600" />
      {t('status.connected')}
    </Badge>
  ) : (
    <Badge tone="neutral">
      <Circle className="h-3 w-3 text-muted-soft" />
      {live?.connectionStatus === 'failed' ? t('status.issue') : t('status.not_connected')}
    </Badge>
  );
}

export function ProviderCard({ provider, viaOpenRouter = false }: { provider: AiProvider; viaOpenRouter?: boolean }) {
  const { t } = useI18n();
  const [live, setLive] = useState<ProviderPublic | undefined>();
  const [models, setModels] = useState<number | undefined>();
  const [apiKey, setApiKey] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (provider.id !== 'openrouter') return;
    let active = true;
    listOpenRouter()
      .then((p) => active && setLive(p))
      .catch(() => {});
    listOpenRouterModels()
      .then((m) => active && setModels(m.count))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [provider.id]);

  if (viaOpenRouter) {
    return (
      <div className="flex flex-col rounded-xl2 border border-surface-line bg-surface-card p-5 opacity-75 shadow-card">
        <div className="flex items-start justify-between">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold text-white" style={{ backgroundColor: provider.accentColor }}>
            {provider.name.charAt(0)}
          </div>
          <Badge tone="neutral">{t('provider.availableVia')}</Badge>
        </div>
        <h4 className="mt-4 text-base font-semibold text-slate-900">{provider.name}</h4>
        <p className="mt-1 text-sm text-muted-soft">{t(provider.taglineI18nKey)}</p>
      </div>
    );
  }

  const connected = live?.connectionStatus === 'connected' || (live?.connectionStatus === undefined && provider.status === 'connected');

  const run = async (fn: () => Promise<unknown>, okText: string, errKey: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ tone: 'ok', text: t(okText) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setNotice({ tone: 'err', text: msg.includes('authentication required') ? t('provider.authRequired') : t(errKey) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col rounded-xl2 border border-surface-line bg-surface-card p-5 shadow-card transition hover:shadow-lift">
      <div className="flex items-start justify-between">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold text-white" style={{ backgroundColor: provider.accentColor }}>
          {provider.name.charAt(0)}
        </div>
        <ProviderStatus provider={provider} live={live} />
      </div>

      <h4 className="mt-4 text-base font-semibold text-slate-900">{provider.name}</h4>
      <p className="mt-1 text-sm text-muted-soft">{t(provider.taglineI18nKey)}</p>

      <div className="mt-4 rounded-lg bg-surface px-3 py-2 text-sm text-muted">
        {live?.credentialConfigured || provider.apiKeyConfigured ? (
          <span className="tracking-wide" dir="ltr">
            {live?.maskedKey ?? provider.maskedKey}
          </span>
        ) : (
          t('provider.apiKey') + ': —'
        )}
      </div>

      <div className="mt-3 flex items-center gap-4 text-xs text-muted-soft">
        {models !== undefined ? (
          <span>
            {models} {t('provider.modelsAvailable')}
          </span>
        ) : null}
        {connected ? (
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-success-600" />
            {t('provider.lastChecked')}: {live?.lastTestedAt ? new Date(live.lastTestedAt).toLocaleString() : '—'}
          </span>
        ) : null}
      </div>

      {provider.id === 'openrouter' && showForm ? (
        <div className="mt-4 space-y-2">
          <input
            type="password"
            placeholder={t('provider.apiKeyPlaceholder')}
            value={apiKey}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
            className="w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!apiKey.trim()) throw new Error(t('provider.required'));
                  setLive(await connectOpenRouter(apiKey.trim()));
                  setShowForm(false);
                  setApiKey('');
                }, 'provider.saved', 'provider.errorUnknown')
              }
            >
              <Plug className="h-4 w-4" /> {t('provider.connectShort')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setShowForm(false)}>
              {t('status.issue')}
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className={`mt-3 text-xs ${notice.tone === 'ok' ? 'text-success-700' : 'text-rose-500'}`}>{notice.text}</p>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2 pt-1">
        {connected ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => run(async () => { const s = await testOpenRouter(); setLive((p) => ({ ...(p ?? { provider: 'openrouter', connectionStatus: 'not_configured' as const, credentialConfigured: false }), connectionStatus: s.status })); }, 'provider.saved', 'provider.errorUnknown')}>
              <Plug className="h-4 w-4" /> {busy ? t('provider.testing') : t('provider.test')}
            </Button>
            <Button variant="primary" onClick={() => setShowForm(true)}>
              {t('provider.manage')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await revokeOpenRouter(); setLive((p) => ({ ...(p ?? { provider: 'openrouter', connectionStatus: 'not_configured' as const, credentialConfigured: false }), connectionStatus: 'not_configured', credentialConfigured: false, maskedKey: undefined })); }, 'provider.saved', 'provider.errorUnknown')}>
              <Trash2 className="h-4 w-4" /> {t('provider.revoke')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setShowForm((s) => !s)}>
            <Plug className="h-4 w-4" /> {t('provider.connect')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ProviderGrid({
  providers,
  viaOpenRouter = [],
}: {
  providers: AiProvider[];
  viaOpenRouter?: AiProvider[];
}) {
  return (
    <div className="grid grid-cols-1 gap-5 p-6 pt-0 sm:grid-cols-2 xl:grid-cols-4">
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
      {viaOpenRouter.map((p) => (
        <ProviderCard key={p.id} provider={p} viaOpenRouter />
      ))}
    </div>
  );
}