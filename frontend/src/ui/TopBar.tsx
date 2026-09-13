import { Search, Bell, ChevronDown, Languages } from 'lucide-react';
import { useI18n } from '../i18n';

export function TopBar() {
  const { t, toggle, locale } = useI18n();
  return (
    <header className="flex h-16 items-center gap-4 border-b border-surface-line bg-white px-6">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1.5 rounded-lg border border-surface-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-slate-50"
        title="Language / اللغة"
      >
        <Languages className="h-3.5 w-3.5" />
        {locale === 'ar' ? 'EN' : 'ع'}
      </button>

      <div className="relative hidden max-w-md flex-1 md:block">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-soft" />
        <input
          placeholder={t('topbar.search')}
          className="w-full rounded-lg border border-surface-line bg-surface py-2 ps-9 pe-10 text-sm text-slate-800 outline-none transition focus:border-brand-400 focus:bg-white"
        />
        <kbd className="absolute end-3 top-1/2 -translate-y-1/2 rounded border border-surface-line bg-white px-1.5 py-0.5 text-[10px] text-muted-soft">
          {t('topbar.searchHint')}
        </kbd>
      </div>

      <div className="ms-auto flex items-center gap-3">
        <button type="button" className="relative rounded-lg p-2 text-muted hover:bg-slate-50" aria-label={t('topbar.notifications')}>
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute end-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
        </button>
        <button type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
            SA
          </span>
          <span className="hidden text-sm font-medium text-slate-700 sm:block">{t('topbar.admin')}</span>
          <ChevronDown className="h-4 w-4 text-muted-soft" />
        </button>
      </div>
    </header>
  );
}