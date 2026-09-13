import { Plug, Eye, EyeOff, CheckCircle2, Circle } from 'lucide-react';
import type { AiProvider } from '../contracts/models';
import { useI18n } from '../i18n';
import { Badge, Button } from '../ui/primitives';

function ProviderStatus({ provider }: { provider: AiProvider }) {
  const { t } = useI18n();
  if (provider.status === 'connected') {
    return (
      <Badge tone="success">
        <span className="h-1.5 w-1.5 rounded-full bg-success-600" />
        {t('status.connected')}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <Circle className="h-3 w-3 text-muted-soft" />
      {t('status.not_connected')}
    </Badge>
  );
}

export function ProviderCard({ provider }: { provider: AiProvider }) {
  const { t } = useI18n();
  const connected = provider.status === 'connected';

  return (
    <div className="flex flex-col rounded-xl2 border border-surface-line bg-surface-card p-5 shadow-card transition hover:shadow-lift">
      <div className="flex items-start justify-between">
        <div
          className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-bold text-white"
          style={{ backgroundColor: provider.accentColor }}
        >
          {provider.name.charAt(0)}
        </div>
        <ProviderStatus provider={provider} />
      </div>

      <h4 className="mt-4 text-base font-semibold text-slate-900">{provider.name}</h4>
      <p className="mt-1 text-sm text-muted-soft">{t(provider.taglineI18nKey)}</p>

      {provider.apiKeyConfigured ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm text-muted">
          <span dir="ltr" className="tracking-wide">{provider.maskedKey}</span>
          <button type="button" className="text-muted-soft hover:text-slate-700">
            <Eye className="h-3.5 w-3.5" />
          </button>
          <EyeOff className="h-3.5 w-3.5 text-muted-soft" />
        </div>
      ) : (
        <div className="mt-4 rounded-lg bg-surface px-3 py-2 text-sm text-muted-soft">{t('provider.apiKey')}: —</div>
      )}

      <div className="mt-3 flex items-center gap-4 text-xs text-muted-soft">
        {provider.modelsAvailable !== undefined ? (
          <span>{provider.modelsAvailable} {t('provider.modelsAvailable')}</span>
        ) : null}
        {connected && provider.lastCheckedLabel ? (
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-success-600" />
            {t('provider.lastChecked')}: {t(provider.lastCheckedLabel)}
          </span>
        ) : null}
      </div>

      <div className="mt-5 flex gap-2 pt-1">
        {connected ? (
          <>
            <Button variant="outline" className="flex-1">
              <Plug className="h-4 w-4" /> {t('provider.test')}
            </Button>
            <Button variant="primary" className="flex-1">
              {t('provider.manage')}
            </Button>
          </>
        ) : (
          <Button variant="primary" className="w-full">
            <Plug className="h-4 w-4" /> {t('provider.connect')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ProviderGrid({ providers }: { providers: AiProvider[] }) {
  return (
    <div className="grid grid-cols-1 gap-5 p-6 pt-0 sm:grid-cols-2 xl:grid-cols-4">
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
    </div>
  );
}