import {
  Home,
  FolderKanban,
  BookOpen,
  Sparkles,
  BrainCircuit,
  Users,
  Plug,
  FileText,
  Settings,
  FlaskConical,
  Hexagon,
  Crown,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';

// `to` present = implemented route. Items without `to` are future screens (rendered inert).
const ITEMS = [
  { key: 'nav.home', icon: Home },
  { key: 'nav.projects', icon: FolderKanban },
  { key: 'nav.knowledge', icon: BookOpen, to: '/knowledge' },
  { key: 'nav.skills', icon: Sparkles },
  { key: 'nav.ai', icon: BrainCircuit, to: '/ai-models' },
  { key: 'nav.tests', icon: FlaskConical, to: '/tests' },
  { key: 'nav.users', icon: Users },
  { key: 'nav.integrations', icon: Plug },
  { key: 'nav.reports', icon: FileText },
  { key: 'nav.settings', icon: Settings },
] as const;

export function Sidebar() {
  const { t } = useI18n();
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-e border-surface-line bg-white lg:flex">
      <div className="flex items-center gap-3 px-6 py-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Hexagon className="h-5 w-5" strokeWidth={2.4} />
        </div>
        <div>
          <div className="text-base font-bold tracking-tight text-slate-900">{t('app.name')}</div>
          <div className="text-[11px] text-muted-soft">{t('app.tagline')}</div>
        </div>
      </div>

      <nav className="mt-2 flex-1 space-y-1 px-3">
        {ITEMS.map((it) => {
          const Icon = it.icon;
          const to = 'to' in it ? it.to : undefined;
          const base = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition';
          if (!to) {
            return (
              <button
                key={it.key}
                type="button"
                className={`${base} text-muted/70 hover:bg-slate-50 hover:text-slate-700`}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
                <span dir="auto">{t(it.key)}</span>
              </button>
            );
          }
          return (
            <NavLink
              key={it.key}
              to={to}
              className={({ isActive }) =>
                `${base} ${isActive ? 'bg-brand-50 text-brand-700' : 'text-muted hover:bg-slate-50 hover:text-slate-800'}`
              }
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
              <span dir="auto">{t(it.key)}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="p-4">
        <div className="rounded-xl2 border border-surface-line bg-gradient-to-b from-brand-50 to-white p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <Crown className="h-4 w-4 text-brand-600" /> {t('pro.title')}
          </div>
          <p className="mt-1 text-xs text-muted-soft">{t('pro.subtitle')}</p>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full w-2/5 rounded-full bg-brand-600" />
          </div>
          <div className="mt-1.5 text-[11px] text-muted-soft">{t('pro.progress')}</div>
          <button
            type="button"
            className="mt-3 w-full rounded-lg bg-brand-600 py-1.5 text-xs font-semibold text-white hover:bg-brand-700"
          >
            {t('pro.upgrade')}
          </button>
        </div>
      </div>
    </aside>
  );
}