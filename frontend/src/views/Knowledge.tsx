import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Link2,
  FileUp,
  ClipboardPaste,
  Github,
  HardDrive,
  Pencil,
  Archive,
  Loader2,
  X,
  Upload,
  Play,
  RefreshCw,
  Sparkles,
  FileText,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useProjectContext } from '../contexts/ProjectContext';
import { apiKip } from '../api/kip';
import type { KipSource, SourceType, ExternalConnection, IngestionJobView, ChunkView, DocumentView, IndexStatusView, RetrievalHitView } from '../api/kip';
import { Card, CardHeader, Button } from '../ui/primitives';

type Mode = 'url' | 'text' | 'file' | 'github' | 'google_drive';

const ACCEPT = '.pdf,.docx,.txt,.pptx,.md';

const SOURCE_ICON: Record<SourceType, typeof Link2> = {
  url: Link2,
  text: ClipboardPaste,
  file: FileUp,
  github: Github,
  google_drive: HardDrive,
};

export function Knowledge() {
  const { t } = useI18n();
  const { activeProject } = useProjectContext();

  const [sources, setSources] = useState<KipSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [picker, setPicker] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [editing, setEditing] = useState<KipSource | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [uri, setUri] = useState('');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [connections, setConnections] = useState<ExternalConnection[]>([]);
  const [ingestions, setIngestions] = useState<Record<string, IngestionJobView>>({});
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  // Canonical documents (K12): inspection is read-only and minimal.
  const [docsFor, setDocsFor] = useState<KipSource | null>(null);
  const [docs, setDocs] = useState<DocumentView[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocumentView | null>(null);
  const [chunks, setChunks] = useState<ChunkView[]>([]);
  const [openChunkFor, setOpenChunkFor] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<ChunkView | null>(null);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [indexBySource, setIndexBySource] = useState<Record<string, IndexStatusView>>({});
  const [indexBusyId, setIndexBusyId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RetrievalHitView[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchPerformed, setSearchPerformed] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [connNotice, setConnNotice] = useState<string | null>(null);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const projectId = activeProject?.id;

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [list, jobs] = await Promise.all([
        apiKip().listSources(projectId),
        apiKip().listProjectIngestions(projectId),
      ]);
      setSources(list);
      setIngestions(Object.fromEntries(jobs.map((j) => [j.sourceId, j])));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('knowledge.error.load'));
      setSources([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  const loadConnections = useCallback(async () => {
    if (!projectId) return;
    try {
      setConnections(await apiKip().listConnections(projectId));
    } catch {
      setConnections([]);
    }
  }, [projectId]);

  useEffect(() => {
    setSources([]);
    setConnections([]);
    if (projectId) {
      load();
      loadConnections();
    }
  }, [projectId, load, loadConnections]);

  // Return trip from the provider redirect: show a plain, non-technical outcome.
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get('github');
    if (!outcome) return;
    setToast(outcome === 'connected' ? t('knowledge.toast.githubConnected') : t('knowledge.error.connector'));
    window.history.replaceState({}, '', window.location.pathname);
  }, [t]);

  const resetForm = () => {
    setTitle('');
    setUri('');
    setContent('');
    setDescription('');
    setFile(null);
    setFormError(null);
    setConnNotice(null);
  };

  const openPicker = () => {
    resetForm();
    setPicker(true);
  };

  const choose = (m: Mode) => {
    setPicker(false);
    setEditing(null);
    resetForm();
    setMode(m);
  };

  const openEdit = (s: KipSource) => {
    setEditing(s);
    setMode('url');
    setTitle(s.title);
    setUri(s.externalUri ?? '');
    setDescription(s.description ?? '');
    setContent('');
    setFile(null);
    setFormError(null);
  };

  const closeDrawer = () => {
    setMode(null);
    setEditing(null);
    resetForm();
  };

  const submit = async () => {
    if (!projectId || !mode) return;
    setFormError(null);
    const cleanTitle = title.trim();
    const cleanDesc = description.trim() || undefined;
    if (mode !== 'file' && !cleanTitle) return setFormError(t('knowledge.form.titleRequired'));

    setSubmitting(true);
    try {
      if (editing) {
        await apiKip().updateSource(projectId, editing.id, {
          title: cleanTitle,
          description,
          ...(mode === 'url' ? { externalUri: uri.trim() } : {}),
        });
        setToast(t('knowledge.toast.updated'));
      } else if (mode === 'url') {
        const cleanUri = uri.trim();
        if (!/^https?:\/\/.+/i.test(cleanUri)) return setFormError(t('knowledge.form.urlRequired'));
        await apiKip().createUrlSource(projectId, { title: cleanTitle, externalUri: cleanUri, description: cleanDesc });
        setToast(t('knowledge.toast.created'));
      } else if (mode === 'text') {
        const cleanContent = content.trim();
        if (!cleanContent) return setFormError(t('knowledge.form.contentRequired'));
        await apiKip().createTextSource(projectId, { title: cleanTitle, content: cleanContent, description: cleanDesc });
        setToast(t('knowledge.toast.created'));
      } else if (mode === 'file') {
        if (!file) return setFormError(t('knowledge.form.fileRequired'));
        await apiKip().uploadFileSource(projectId, file, { title: cleanTitle || file.name, description: cleanDesc });
        setToast(t('knowledge.toast.created'));
      }
      closeDrawer();
      await load(); // authoritative refetch — never optimistic
      await loadConnections();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t('knowledge.error.save'));
    } finally {
      setSubmitting(false);
    }
  };

  const doArchive = async (id: string) => {
    if (!projectId) return;
    setArchivingId(id);
    try {
      await apiKip().archiveSource(projectId, id);
      setConfirmId(null);
      setToast(t('knowledge.toast.archived'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('knowledge.error.archive'));
    } finally {
      setArchivingId(null);
    }
  };

  const processSource = async (source: KipSource) => {
    if (!projectId) return;
    setBusySourceId(source.id);
    try {
      const { job } = await apiKip().startIngestion(projectId, source.id);
      setToast(job.status === 'failed' ? job.errorMessage ?? t('ingestion.toast.failed') : t('ingestion.toast.done'));
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('ingestion.toast.failed'));
    } finally {
      setBusySourceId(null);
    }
  };

  const retrySource = async (job: IngestionJobView) => {
    if (!projectId) return;
    setBusySourceId(job.sourceId);
    try {
      const outcome = await apiKip().retryIngestion(projectId, job.id);
      setToast(outcome.job.status === 'failed' ? outcome.job.errorMessage ?? t('ingestion.toast.failed') : t('ingestion.toast.done'));
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('ingestion.toast.failed'));
    } finally {
      setBusySourceId(null);
    }
  };

  // K15: retrieval lab — ranked evidence only, no answer generation.
  const runSearch = async () => {
    if (!projectId) return;
    const query = searchQuery.trim();
    if (query.length === 0) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await apiKip().searchKnowledge(projectId, { query, topK: 8 });
      setSearchResults(res.results);
      setSearchPerformed(true);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : t('retrieval.error'));
      setSearchResults([]);
      setSearchPerformed(true);
    } finally {
      setSearching(false);
    }
  };

  // K14: index readiness is FETCHED, never inferred from ingestion status.
  const refreshIndexStatuses = useCallback(async () => {
    if (!projectId || sources.length === 0) return;
    const entries = await Promise.all(
      sources.map(async (s) => {
        try {
          return [s.id, await apiKip().indexStatus(projectId, s.id)] as const;
        } catch {
          return null;
        }
      }),
    );
    const next: Record<string, IndexStatusView> = {};
    for (const entry of entries) if (entry) next[entry[0]] = entry[1];
    setIndexBySource(next);
  }, [projectId, sources]);

  useEffect(() => {
    void refreshIndexStatuses();
  }, [refreshIndexStatuses]);

  /** 'فهرسة المعرفة': explicit indexing. Never triggers on its own. */
  const indexSourceKnowledge = async (source: KipSource) => {
    if (!projectId) return;
    setIndexBusyId(source.id);
    try {
      await apiKip().indexSourceKnowledge(projectId, source.id);
      await refreshIndexStatuses();
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('index.error'));
    } finally {
      setIndexBusyId(null);
    }
  };

  // K11: one Process action covers every supported source type.
  const openDocuments = async (source: KipSource) => {
    if (!projectId) return;
    setDocsFor(source);
    setDocs([]);
    setSelectedDoc(null);
    setDocsLoading(true);
    try {
      const res = await apiKip().listSourceDocuments(projectId, source.id);
      setDocs(res.documents);
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('documents.error'));
    } finally {
      setDocsLoading(false);
    }
  };

  const closeDocuments = () => {
    setDocsFor(null);
    setDocs([]);
    setSelectedDoc(null);
    setChunks([]);
    setOpenChunkFor(null);
    setSelectedChunk(null);
  };

  // K13: the chunk list stays metadata + a short preview; the full text is
  // fetched only when one chunk is opened.
  const openChunks = async (documentId: string) => {
    if (!projectId) return;
    if (openChunkFor === documentId) {
      setOpenChunkFor(null);
      setChunks([]);
      setSelectedChunk(null);
      return;
    }
    setOpenChunkFor(documentId);
    setSelectedChunk(null);
    setChunks([]);
    setChunksLoading(true);
    try {
      const res = await apiKip().listDocumentChunks(projectId, documentId);
      setChunks(res.chunks);
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('chunks.error'));
    } finally {
      setChunksLoading(false);
    }
  };

  const viewChunk = async (chunkId: string) => {
    if (!projectId) return;
    try {
      setSelectedChunk(await apiKip().getChunk(projectId, chunkId));
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('chunks.error'));
    }
  };

  const viewDocument = async (documentId: string) => {
    if (!projectId) return;
    try {
      setSelectedDoc(await apiKip().getDocument(projectId, documentId));
    } catch (e) {
      setToast(e instanceof Error ? e.message : t('documents.error'));
    }
  };

  const ingestible = (type: SourceType) => type === 'text' || type === 'file' || type === 'url' || type === 'github';

  const statusLabel = (status?: string) =>
    !status ? t('ingestion.status.none') : t('ingestion.status.' + status);

  /**
   * Two concepts, stated plainly: content readiness and index readiness.
   * Technical states are never shown — only Arabic-first wording.
   */
  const indexLabelFor = (sourceId: string) => {
    const view = indexBySource[sourceId];
    if (!view) return t('index.state.none');
    if (view.job?.status === 'queued' || view.job?.status === 'processing') return t('index.state.indexing');
    if (view.job?.status === 'failed') return t('index.state.failed');
    if (view.index.modelMatches === false) return t('index.state.stale');
    switch (view.index.state) {
      case 'ready':
        return t('index.state.ready');
      case 'indexing':
        return t('index.state.indexing');
      case 'partial':
        return t('index.state.partial');
      default:
        return t('index.state.none');
    }
  };

  const indexClass = (state?: string) =>
    state === 'ready'
      ? 'bg-success-100 text-success-700'
      : state === 'failed'
        ? 'bg-rose-50 text-rose-600'
        : state === 'indexing' || state === 'partial'
          ? 'bg-brand-50 text-brand-700'
          : 'bg-slate-100 text-muted';

  const statusClass = (status?: string) =>
    status === 'completed'
      ? 'bg-success-100 text-success-700'
      : status === 'failed'
        ? 'bg-rose-50 text-rose-600'
        : status === 'processing' || status === 'queued'
          ? 'bg-brand-50 text-brand-700'
          : 'bg-slate-100 text-muted';

  const connectionFor = (p: 'github' | 'google_drive') => connections.find((c) => c.provider === p) ?? null;

  const subtitleOf = useMemo(
    () => (s: KipSource) => {
      if (s.sourceType === 'url') {
        try {
          return new URL(s.externalUri ?? '').hostname;
        } catch {
          return s.externalUri ?? '';
        }
      }
      if (s.sourceType === 'file') {
        const size = s.rawArtifact?.byteSize;
        const ext = (s.rawArtifact?.originalName ?? '').split('.').pop()?.toUpperCase() ?? '';
        return size ? `${ext} · ${formatBytes(size)}` : ext;
      }
      if (s.sourceType === 'text') return t('knowledge.type.text.pasted');
      if (s.sourceType === 'github') return s.externalReference?.externalUri ?? 'GitHub';
      if (s.sourceType === 'google_drive') return t('knowledge.type.drive');
      return s.sourceType;
    },
    [t],
  );

  const projectMissing = !activeProject;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{t('knowledge.title')}</h1>
          <p className="mt-1.5 max-w-xl text-sm text-muted">{t('knowledge.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={openPicker} disabled={projectMissing}>
          <Plus className="h-4 w-4" /> {t('knowledge.add')}
        </Button>
      </div>

      {toast ? <div className="mt-4 rounded-lg bg-success-100 px-3 py-2 text-sm text-success-700">{toast}</div> : null}

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
          <Button variant="primary" className="mt-5" onClick={openPicker}>
            <Plus className="h-4 w-4" /> {t('knowledge.add')}
          </Button>
        </Card>
      ) : (
        <>
          {projectId ? (
          <Card className="mt-6 p-4">
            <CardHeader title={t('retrieval.title')} />
            <p className="mt-1 text-xs text-muted-soft">{t('retrieval.hint')}</p>
            <div className="mt-3 flex items-center gap-2">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                }}
                placeholder={t('retrieval.placeholder')}
                className="w-full rounded-lg border border-surface-line px-3 py-2 text-sm text-slate-800 outline-none focus:border-brand-400"
                dir="auto"
              />
              <Button
                variant="outline"
                disabled={searching || searchQuery.trim().length === 0}
                onClick={() => void runSearch()}
              >
                {searching ? t('retrieval.searching') : t('retrieval.action')}
              </Button>
            </div>
            {searchError ? <p className="mt-2 text-xs text-rose-600">{searchError}</p> : null}
            {searchResults.length > 0 ? (
              <ul className="mt-4 divide-y divide-surface-line rounded-xl border border-surface-line">
                {searchResults.map((r) => (
                  <li key={r.position} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="shrink-0 text-xs font-medium text-slate-700">
                        {t('retrieval.rank')} {r.position}
                      </span>
                      <span className="truncate text-xs text-muted-soft" dir="auto">
                        {r.logicalPath ?? r.document ?? ''}
                      </span>
                    </div>
                    {r.headingContext ? (
                      <div className="mt-1 truncate text-[11px] text-muted-soft" dir="auto">
                        {r.headingContext}
                      </div>
                    ) : null}
                    <p className="mt-1 whitespace-pre-wrap text-xs text-slate-700" dir="auto">
                      {r.text.slice(0, 320)}
                    </p>
                    {r.source ? (
                      <div className="mt-1 text-[11px] text-muted-soft" dir="auto">
                        {r.source}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : searchPerformed && !searching ? (
              <p className="mt-3 text-xs text-muted-soft">{t('retrieval.empty')}</p>
            ) : null}
          </Card>
        ) : null}

        <Card className="mt-6">
          <CardHeader title={t('knowledge.sources')} />
          <ul className="divide-y divide-surface-line px-2 pb-2">
            {sources.map((s) => {
              const Icon = SOURCE_ICON[s.sourceType] ?? Link2;
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800">{s.title}</div>
                    <div className="truncate text-xs text-muted-soft" dir="auto">
                      {subtitleOf(s)}
                    </div>
                    {s.description ? <p className="mt-0.5 truncate text-xs text-muted">{s.description}</p> : null}
                  </div>
                  {ingestible(s.sourceType) ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${statusClass(ingestions[s.id]?.status)}`}>
                        {ingestions[s.id]?.status === 'completed'
                          ? t('index.content.done')
                          : statusLabel(ingestions[s.id]?.status)}
                      </span>
                      {ingestions[s.id]?.status === 'failed' ? (
                        <Button
                          variant="ghost"
                          disabled={busySourceId === s.id}
                          onClick={() => retrySource(ingestions[s.id])}
                          title={t('ingestion.retry')}
                        >
                          <RefreshCw className="h-4 w-4" /> {t('ingestion.retry')}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={busySourceId === s.id || ingestions[s.id]?.status === 'processing' || ingestions[s.id]?.status === 'queued'}
                          onClick={() => processSource(s)}
                          title={t('ingestion.process')}
                        >
                          <Play className="h-4 w-4" /> {busySourceId === s.id ? t('ingestion.status.processing') : t('ingestion.process')}
                        </Button>
                      )}
                      {ingestions[s.id]?.status === 'completed' ? (
                        <Button variant="ghost" onClick={() => openDocuments(s)} title={t('documents.open')}>
                          <FileText className="h-4 w-4" /> {t('documents.open')}
                        </Button>
                      ) : null}
                      {ingestions[s.id]?.status === 'completed' ? (
                        <>
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${indexClass(
                              indexBySource[s.id]?.job?.status === 'failed'
                                ? 'failed'
                                : indexBySource[s.id]?.index.state,
                            )}`}
                          >
                            {indexLabelFor(s.id)}
                          </span>
                          {indexBySource[s.id]?.job?.status === 'failed' ||
                          indexBySource[s.id]?.index.modelMatches === false ? (
                            <Button
                              variant="ghost"
                              disabled={indexBusyId === s.id}
                              onClick={() => indexSourceKnowledge(s)}
                              title={t('index.action')}
                            >
                              <RefreshCw className={`h-4 w-4 ${indexBusyId === s.id ? 'animate-spin' : ''}`} />
                              {indexBusyId === s.id ? t('index.working') : t('index.action')}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              disabled={indexBusyId === s.id || indexBySource[s.id]?.index.state === 'indexing'}
                              onClick={() => indexSourceKnowledge(s)}
                              title={t('index.action')}
                            >
                              <Sparkles className={`h-4 w-4 ${indexBusyId === s.id ? 'animate-spin' : ''}`} />
                              {indexBusyId === s.id ? t('index.working') : t('index.action')}
                            </Button>
                          )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex shrink-0 items-center gap-1">
                    {s.sourceType === 'url' ? (
                      <Button variant="ghost" onClick={() => openEdit(s)} title={t('knowledge.edit')}>
                        <Pencil className="h-4 w-4" /> {t('knowledge.edit')}
                      </Button>
                    ) : null}
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
              );
            })}
          </ul>
        </Card>
        </>
      )}

      {/* How do you want to add knowledge? */}
      {picker ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4" onClick={() => setPicker(false)}>
          <div className="w-full max-w-lg rounded-xl2 bg-white p-6 shadow-lift" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-semibold text-slate-900">{t('knowledge.picker.title')}</h2>
              <button type="button" onClick={() => setPicker(false)} className="text-muted-soft hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 space-y-2">
              <Choice icon={FileUp} title={t('knowledge.type.file')} hint={t('knowledge.type.file.hint')} onClick={() => choose('file')} />
              <Choice icon={ClipboardPaste} title={t('knowledge.type.text')} hint={t('knowledge.type.text.hint')} onClick={() => choose('text')} />
              <Choice icon={Link2} title={t('knowledge.type.url')} hint={t('knowledge.type.url.hint')} onClick={() => choose('url')} />
              <Choice
                icon={Github}
                title="GitHub"
                hint={t('knowledge.type.github.hint')}
                onClick={() => choose('github')}
              />
              <Choice
                icon={HardDrive}
                title="Google Drive"
                hint={t('knowledge.type.drive.hint')}
                onClick={() => choose('google_drive')}
              />
            </div>
          </div>
        </div>
      ) : null}

      {/* Add / edit drawer */}
      {mode ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
          <div className="h-full w-full max-w-md overflow-y-auto border-s border-surface-line bg-white p-6 shadow-lift">
            <h2 className="text-lg font-semibold text-slate-900">{t(`knowledge.form.title.${mode}`)}</h2>
            {formError ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{formError}</p> : null}
            {connNotice ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{connNotice}</p> : null}

            {mode === 'github' || mode === 'google_drive' ? (
              <ConnectorPanel
                provider={mode}
                connection={connectionFor(mode)}
                projectId={projectId}
                onRegistered={async () => {
                  setToast(t('knowledge.toast.created'));
                  closeDrawer();
                  await load();
                }}
                onError={setConnNotice}
              />
            ) : (
              <>
                {mode === 'file' ? (
                  <>
                    <label className="mt-5 block text-sm font-medium text-slate-700">{t('knowledge.form.file')}</label>
                    <input
                      type="file"
                      accept={ACCEPT}
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm"
                    />
                    <p className="mt-1 text-xs text-muted-soft">{t('knowledge.form.fileHint')}</p>
                  </>
                ) : null}

                <label className="mt-5 block text-sm font-medium text-slate-700">
                  {t('knowledge.form.title')}
                  {mode === 'file' ? <span className="text-muted-soft"> — {t('knowledge.optional')}</span> : null}
                </label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
                />

                {mode === 'url' ? (
                  <>
                    <label className="mt-4 block text-sm font-medium text-slate-700">{t('knowledge.form.url')}</label>
                    <input
                      dir="ltr"
                      value={uri}
                      onChange={(e) => setUri(e.target.value)}
                      placeholder="https://example.com"
                      className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
                    />
                  </>
                ) : null}

                {mode === 'text' ? (
                  <>
                    <label className="mt-4 block text-sm font-medium text-slate-700">{t('knowledge.form.content')}</label>
                    <textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      rows={10}
                      className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
                    />
                  </>
                ) : null}

                <label className="mt-4 block text-sm font-medium text-slate-700">
                  {t('knowledge.form.description')} <span className="text-muted-soft">— {t('knowledge.optional')}</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-surface-line bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
                />
              </>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={closeDrawer}>
                {t('knowledge.cancel')}
              </Button>
              {mode === 'github' || mode === 'google_drive' ? null : (
                <Button variant="primary" disabled={submitting} onClick={submit}>
                  {submitting ? t('knowledge.saving') : t('knowledge.save')}
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* Canonical documents (K12): read-only inspection, no internals exposed. */}
      {docsFor ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
          <div className="h-full w-full max-w-lg overflow-y-auto border-s border-surface-line bg-white p-6 shadow-lift">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-semibold text-slate-900">{t('documents.title')}</h2>
              <button type="button" onClick={closeDocuments} className="text-muted-soft hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-1 truncate text-xs text-muted-soft" dir="auto">
              {docsFor.title}
            </p>

            {docsLoading ? (
              <p className="mt-4 text-sm text-muted-soft">{t('documents.loading')}</p>
            ) : docs.length === 0 ? (
              <p className="mt-4 text-sm text-muted-soft">{t('documents.empty')}</p>
            ) : (
              <>
                <ul className="mt-4 divide-y divide-surface-line rounded-xl border border-surface-line">
                  {docs.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-slate-800" dir="auto">
                          {d.logicalPath ?? d.title ?? d.contentType}
                        </span>
                        <span className="block text-xs text-muted-soft">
                          {d.charCount} {t('documents.chars')}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Button variant="outline" onClick={() => openChunks(d.id)}>
                          {t('chunks.open')}
                        </Button>
                        <Button variant="outline" onClick={() => viewDocument(d.id)}>
                          {t('documents.view')}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
                {selectedDoc ? (
                  <div className="mt-4">
                    <div className="truncate text-xs text-muted-soft" dir="auto">
                      {selectedDoc.logicalPath ?? selectedDoc.title ?? ''}
                    </div>
                    <pre
                      className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-surface-line bg-surface p-3 text-xs text-slate-700"
                      dir="auto"
                    >
                      {selectedDoc.normalizedText ?? ''}
                    </pre>
                  </div>
                ) : null}
                {openChunkFor ? (
                  <div className="mt-4 rounded-lg border border-surface-line p-3">
                    <h3 className="text-sm font-semibold text-slate-900">{t('chunks.title')}</h3>
                    {chunksLoading ? (
                      <p className="mt-2 text-xs text-muted-soft">{t('chunks.loading')}</p>
                    ) : chunks.length === 0 ? (
                      <p className="mt-2 text-xs text-muted-soft">{t('chunks.empty')}</p>
                    ) : (
                      <ul className="mt-2 divide-y divide-surface-line">
                        {chunks.map((c) => (
                          <li key={c.id} className="py-2">
                            <button type="button" onClick={() => viewChunk(c.id)} className="w-full text-start">
                              <span className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium text-slate-700" dir="auto">
                                  {t('chunks.number')} {c.chunkIndex + 1}
                                  {c.headingContext ? ' · ' + c.headingContext : ''}
                                </span>
                                <span className="shrink-0 text-xs text-muted-soft">
                                  {c.charCount} {t('documents.chars')}
                                </span>
                              </span>
                              {c.logicalPath ? (
                                <span className="mt-1 block truncate text-[11px] text-muted-soft" dir="auto">
                                  {c.logicalPath}
                                </span>
                              ) : null}
                              <span className="mt-1 block truncate text-[11px] text-muted-soft" dir="auto">
                                {c.preview}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {selectedChunk?.text ? (
                      <pre
                        className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-surface-line bg-surface p-3 text-xs text-slate-700"
                        dir="auto"
                      >
                        {selectedChunk.text}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Choice({ icon: Icon, title, hint, onClick }: { icon: typeof Link2; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-surface-line bg-white px-4 py-3 text-start transition hover:border-brand-300 hover:bg-brand-50/40"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{title}</span>
        <span className="block truncate text-xs text-muted-soft">{hint}</span>
      </span>
    </button>
  );
}

/** Connection state for a provider. Browsing needs a configured connector. */
function ConnectorPanel({
  provider,
  connection,
  projectId,
  onRegistered,
  onError,
}: {
  provider: 'github' | 'google_drive';
  connection: ExternalConnection | null;
  projectId?: string;
  onRegistered: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Array<{ id: string; name: string; type: string; uri?: string; detail?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const connected = connection?.status === 'connected';

  const browse = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      setItems(
        provider === 'github'
          ? await apiKip().listGitHubRepositories(projectId)
          : await apiKip().listConnectionItems(projectId, provider),
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : t('knowledge.conn.notConfigured'));
    } finally {
      setBusy(false);
    }
  };

  // GitHub is a real provider redirect: the browser must leave the SPA and come back.
  const connect = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const { url } = await apiKip().startGitHubConnect(projectId);
      window.location.href = url;
    } catch (e) {
      onError(e instanceof Error ? e.message : t('knowledge.conn.notConfigured'));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      await apiKip().disconnectGitHub(projectId);
      setItems([]);
      await onRegistered();
    } catch (e) {
      onError(e instanceof Error ? e.message : t('knowledge.conn.notConfigured'));
    } finally {
      setBusy(false);
    }
  };

  const register = async (item: { id: string; name: string; type: string; uri?: string; detail?: string }) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await apiKip().registerExternalSource(projectId, provider, {
        itemId: item.id,
        itemType: item.type,
        name: item.name,
        uri: item.uri,
        detail: item.detail,
      });
      await onRegistered();
    } catch (e) {
      onError(e instanceof Error ? e.message : t('knowledge.error.save'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      <div className="rounded-xl border border-surface-line bg-surface p-4">
        <div className="text-sm font-medium text-slate-800">
          {provider === 'github' ? 'GitHub' : 'Google Drive'}
        </div>
        <div className="mt-1 text-xs text-muted-soft">
          {connected ? (connection?.accountLabel ?? t('knowledge.conn.connected')) : t('knowledge.conn.notConnected')}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {connected ? (
            <>
              <Button variant="primary" onClick={browse} disabled={busy}>
                <Upload className="h-4 w-4" /> {t('knowledge.conn.choose')}
              </Button>
              {provider === 'github' ? (
                <Button variant="ghost" onClick={disconnect} disabled={busy}>
                  {t('knowledge.conn.disconnect')}
                </Button>
              ) : null}
            </>
          ) : (
            <Button variant="default" onClick={connect} disabled={busy}>
              {provider === 'github' ? t('knowledge.conn.connectGithub') : t('knowledge.conn.connectDrive')}
            </Button>
          )}
        </div>
      </div>

      {items.length > 0 ? (
        <ul className="mt-4 divide-y divide-surface-line rounded-xl border border-surface-line">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate text-sm text-slate-800">{it.name}</span>
                <span className="block truncate text-xs text-muted-soft">{it.detail ?? it.type}</span>
              </span>
              <Button variant="outline" onClick={() => register(it)} disabled={busy}>
                {t('knowledge.conn.select')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
