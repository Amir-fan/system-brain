import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useProjectContext } from '../contexts/ProjectContext';
import { useI18n } from '../i18n';
import { Sidebar } from '../ui/Sidebar';
import { TopBar } from '../ui/TopBar';

export function ProjectSwitcher() {
  const { projects, activeProject, selectProject } = useProjectContext();
  const { t } = useI18n();

  if (projects.length <= 1) {
    return (
      <div className="flex min-h-[48px] items-center gap-2 rounded-lg border border-surface-line bg-surface px-3 py-2 text-sm">
        {projects.length === 0 ? (
          <span className="text-muted-soft">{t('project.none')}</span>
        ) : (
          <span className="font-medium text-slate-800">{projects[0].name}</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-surface-line bg-surface px-2 py-1.5 text-sm">
      <span className="px-1 text-muted-soft">{t('project.switcher')}</span>
      <select
        value={activeProject?.id ?? ''}
        onChange={(e) => selectProject(e.target.value)}
        className="rounded-md border border-surface-line bg-white px-2 py-1 text-sm font-medium text-slate-800 outline-none"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ProtectedShell({ children }: { children: ReactNode }) {
  const { session, initializing, signOut } = useAuth();
  const { activeProject, loading } = useProjectContext();
  const { t } = useI18n();

  if (initializing || loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-soft">{t('app.loading')}</div>;
  }
  if (!session) {
    return <div className="flex min-h-screen items-center justify-center">{children && null}</div>;
  }

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-surface-line bg-white px-5 py-2.5">
          <ProjectSwitcher />
          <div className="ms-auto flex items-center gap-2">
            <span className="text-sm text-muted-soft">{activeProject?.name ?? ''}</span>
            <button
              type="button"
              onClick={() => signOut()}
              className="rounded-lg border border-surface-line px-3 py-1.5 text-sm text-muted hover:bg-slate-50"
            >
              {t('login.logout')}
            </button>
          </div>
        </div>
        <TopBar />
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}