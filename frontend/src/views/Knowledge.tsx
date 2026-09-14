import { useCallback, useEffect, useState } from 'react';
import { Plus, Link2, Pencil, Archive, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { useProjectContext } from '../contexts/ProjectContext';
import { apiKip } from '../api/kip';
import type { KipSource } from '../api/kip';
import { Card, CardHeader, Button } from '../ui/primitives';

interface FormState {
  title: string;
  externalUri: string;
  description: string;
}

const emptyForm = (): FormState => ({ title: '', externalUri: '', description: '' });

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function Knowledge() {
  const { t } = useI18n();
  const { activeProject } = useProjectContext();
  const [sources, setSources] = useState<KipSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<KipSource | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeProject) return;
    setLoading(true);
    setError(null);
    try {
      setSources(await apiKip().listSources(activeProject.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('knowledge.error.load'));
      setSources([]);
    } finally {
      setLoading(false);
    }
  }, [activeProject?.id, t]);

  useEffect(() => {
    setSources([]);
    if (activeProject) load();
  }, [activeProject?.id, load]);

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError(null);
    setDrawerOpen(true);
  };

  const openEdit = (s: KipSource) => {
    setEditing(s);
    setForm({ title: s.title, externalUri: s.externalUri, description: s.description ?? '' });
    setFormError(null);
    setDrawerOpen(true);
  };

  const submit = async () => {
    const title = form.title.trim();
    const externalUri = form.externalUri.trim();
    const description = form.description.trim() || undefined;
    if (!title) return setFormError(t('knowledge.form.titleRequired'));
    if (!/^https?:\/\/.+/i.test(externalUri)) return setFormError(t('knowledge.form.urlRequired'));
    if (!activeProject) return;
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        await apiKip().updateSource(activeProject.id, editing.id, { title, externalUri, description });
        setToast(t('knowledge.toast.updated'));
      } else {
        await apiKip().createSource(activeProject.id, { sourceType: 'url', title, externalUri, description });
        setToast(t('knowledge.toast.created'));
      }
      setDrawerOpen(false);
      await load(); // authoritative refetch — never optimistic
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t('knowledge.error.save'));
    } finally {
      setSubmitting(false);
    }
  };

  const doArchive = async (id: string) => {
    if (!activeProject) return;
    setArchivingId(id);
    try {
      await apiKip().archiveSource(activeProject.id, id);
      setConfirmId(null);
      setToast(t('knowledge.toast.archived'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('knowledge.error.archive'));
    } finally {
      setArchivingId(null);
    }
  };

  const projectMissing = !activeProject;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      {/* Page header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t('knowledge.title')}</h1>
          <p className="mt-1.5 max-w-xl text-sm text-muted">{t('knowledge.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={openAdd} disabled={projectMissing}>
          <Plus className="h-4 w-4" /> {t('knowledge.add')}
        </Button>
      </div>

      {toast ? (
        <div className="mt-4 rounded-lg bg-success-100 px-3 py-2 text-sm text-success-700">{toast}</div>
      ) : null}

      {/* States */}
      {projectMissing ? (
        <Card className="mt-6 p-10 text-center text-muted-soft">{t('project.none')}</Card>
      ) : loading ? (
        <Card className="mt-6 flex items-center justify-center gap-2 p-12 text-muted-soft">
          <Loader2 className="h-5 w-5 animate-spin" /> {t('knowledge.loading')}
        </Card>
      ) : error && sources.length === 0 ? (
        <Card className="mt-6 p-10 text-center text-rose-600">{error}</Card>
      ) : sources.length === 0 ? (
        <Card className="mt-6 p-12 text-center">
          <p className="text-base font-medium text-slate-700">{t('knowledge.empty.title')}</p>
          <p className="mt-1 text-sm text-muted-soft">{t('knowledge.empty.subtitle')}</p>
          <Button variant="primary" className="mt-5" onClick={openAdd}>
            <Plus className="h-4 w-4" /> {t('knowledge.add')}
          </Button>
        </Card>
      ) : (
        <Card className="mt-6">
          <CardHeader title={t('knowledge.sources')} />
          <ul className="divide-y divide-surface-line px-2 pb-2">
            {sources.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <Link2 className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{s.title}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-soft">
                    <span dir="ltr">{domainOf(s.externalUri)}</span>
                    <span>·</span>
                    <span>{new Date(s.createdAt).toLocaleDateString()}</span>
                  </div>
                  {s.description ? <p className="mt-0.5 truncate text-xs text-muted">{s.description}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" onClick={() => openEdit(s)} title={t('knowledge.edit')}>
                    <Pencil className="h-4 w-4" /> {t('knowledge.edit')}
                  </Button>
                  {confirmId === s.id ? (
                    <span className="flex items-center gap-1 text-xs text-rose-600">
                      {t('knowledge.confirm')}
                      <Button variant="ghost" disabled={archivingId === s.id} onClick={() => doArchive(s.id)}>
                        {t('knowledge.archive')}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmId(null)}>
                        {t('knowledge.cancel')}
                      </Button>
                    </span>
                  ) : (
                    <Button variant="ghost" onClick={() => setConfirmId(s.id)} title={t('knowledge.archive')}>
                      <Archive className="h-4 w-4" /> {t('knowledge.archive')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Add / Edit drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
          <div className="h-full w-full max-w-md overflow-y-auto border-s border-surface-line bg-white p-6 shadow-lift">
            <h2 className="text-lg font-semibold text-slate-900">
              {editing ? t('knowledge.form.editTitle') : t('knowledge.form.addTitle')}
            </h2>
            {formError ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{formError}</p> : null}
            <label className="mt-5 block text-sm font-medium text-slate-700">{t('knowledge.form.title')}</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
            <label className="mt-4 block text-sm font-medium text-slate-700">{t('knowledge.form.url')}</label>
            <input
              dir="ltr"
              value={form.externalUri}
              onChange={(e) => setForm({ ...form, externalUri: e.target.value })}
              placeholder="https://example.com"
              className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
            <label className="mt-4 block text-sm font-medium text-slate-700">{t('knowledge.form.description')}</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
                {t('knowledge.cancel')}
              </Button>
              <Button variant="primary" disabled={submitting} onClick={submit}>
                {submitting ? t('knowledge.saving') : t('knowledge.save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}