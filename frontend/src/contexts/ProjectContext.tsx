import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { apiKip } from '../api/kip';
import type { ActorProject } from '../api/kip';

const STORAGE_KEY = 'kip.activeProjectId';

interface ProjectContextValue {
  projects: ActorProject[];
  activeProject: ActorProject | null;
  loading: boolean;
  error: string | null;
  selectProject: (id: string) => void;
  refresh: () => Promise<void>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ActorProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await apiKip().myProjects();
      setProjects(list);
      const saved = localStorage.getItem(STORAGE_KEY);
      const valid = saved && list.some((p) => p.id === saved) ? saved : null;
      if (valid) {
        setActiveId(valid);
      } else if (list.length === 1) {
        setActiveId(list[0].id);
        localStorage.setItem(STORAGE_KEY, list[0].id);
      } else {
        setActiveId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectProject = (id: string) => {
    if (projects.some((p) => p.id === id)) {
      setActiveId(id);
      localStorage.setItem(STORAGE_KEY, id);
    }
  };

  const activeProject = projects.find((p) => p.id === activeId) ?? null;

  return (
    <ProjectContext.Provider value={{ projects, activeProject, loading, error, selectProject, refresh }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext must be used within ProjectProvider');
  return ctx;
}