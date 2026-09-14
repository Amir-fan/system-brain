/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @purpose Canonical authenticated KIP API client.
 *
 * Adds the bearer access token, applies the refresh-once/retry-once session rule,
 * and normalizes failures into user-actionable messages. Never receives or stores
 * the platform admin token or any provider secret.
 */

import { createSessionPorts } from './session';
import { runWithSessionRetry } from './session-retry';
import type { AttemptResponse } from './session-retry';

const UNEXPECTED_RESPONSE = 'رد غير متوقع من الخادم — تأكد من أن واجهة KIP البرمجية تعمل.';
const UNREACHABLE = 'تعذر الوصول إلى الخادم — تأكد من أن الخادم يعمل وحاول مجددًا.';
const FORBIDDEN = 'ليس لديك صلاحية لهذا المشروع.';

type Body<T> = { data?: T; error?: { message?: string; category?: string } };

async function attempt<T>(path: string, init: RequestInit | undefined, token: string): Promise<AttemptResponse<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    // A non-JSON reply is never a valid KIP API response (e.g. an SPA fallback
    // returning index.html). 401 is excluded so the refresh path still runs.
    if (res.status === 401) return { status: 401, body: {} };
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body<T> };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await runWithSessionRetry(createSessionPorts(), (token) => attempt<T>(path, init, token));
  if (res.status >= 400) {
    // 401 is already handled (refresh + retry, then clean logout) by the session rule.
    if (res.status === 403) throw new Error(FORBIDDEN);
    if (res.status === 404) throw new Error(res.body.error?.message ?? 'العنصر غير موجود.');
    throw new Error(res.body.error?.message ?? `فشل الطلب (${res.status})`);
  }
  return res.body.data as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ---------------------------------------------------------------- contracts

export interface ActorProject {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'service';
  status: string;
}

export type SourceType = 'url' | 'file' | 'text' | 'github' | 'google_drive';

export interface KipSource {
  id: string;
  sourceType: SourceType;
  title: string;
  description?: string;
  externalUri?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  rawArtifact?: RawArtifactInfo;
  externalReference?: ExternalReferenceInfo;
}

export interface RawArtifactInfo {
  kind: 'file' | 'text';
  originalName?: string;
  mimeType?: string;
  byteSize?: number;
}

export interface ExternalReferenceInfo {
  provider: string;
  externalItemId: string;
  externalType: string;
  externalUri?: string;
  displayName?: string;
}

export interface ExternalConnection {
  id: string;
  provider: 'github' | 'google_drive';
  status: 'connected' | 'not_connected' | 'error';
  accountLabel?: string;
}

export interface ChunkView {
  id: string;
  documentId: string;
  chunkIndex: number;
  logicalPath?: string;
  headingContext?: string;
  charCount: number;
  contentSha256: string;
  preview: string;
  /** Present only on the single-chunk read. */
  text?: string;
}

export interface DocumentView {
  id: string;
  sourceId: string;
  title?: string;
  logicalPath?: string;
  contentType: string;
  charCount: number;
  contentSha256: string;
  ordinal: number;
  createdAt: string;
  /** Present only on the single-document read. */
  normalizedText?: string;
}

export type IngestionStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface IngestionJobView {
  id: string;
  sourceId: string;
  status: IngestionStatus;
  attemptNumber: number;
  triggerType: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface ExternalItem {
  id: string;
  name: string;
  type: string;
  uri?: string;
  detail?: string;
}

// ---------------------------------------------------------------- api surface

export function apiKip() {
  return {
    myProjects: () => call<ActorProject[]>('/v1/projects'),

    listSources: (projectId: string) => call<KipSource[]>(`/v1/projects/${projectId}/sources`),
    getSource: (projectId: string, sourceId: string) => call<KipSource>(`/v1/projects/${projectId}/sources/${sourceId}`),
    updateSource: (projectId: string, sourceId: string, body: { title?: string; description?: string; externalUri?: string }) =>
      call<KipSource>(`/v1/projects/${projectId}/sources/${sourceId}`, json('PATCH', body)),
    archiveSource: (projectId: string, sourceId: string) =>
      call<KipSource>(`/v1/projects/${projectId}/sources/${sourceId}`, { method: 'DELETE' }),

    createUrlSource: (projectId: string, body: { title: string; externalUri: string; description?: string }) =>
      call<KipSource>(`/v1/projects/${projectId}/sources`, json('POST', { sourceType: 'url', ...body })),

    createTextSource: (projectId: string, body: { title: string; content: string; description?: string }) =>
      call<KipSource>(`/v1/projects/${projectId}/sources/text`, json('POST', body)),

    uploadFileSource: (projectId: string, file: File, meta: { title?: string; description?: string }) => {
      // The file is the raw request body; metadata rides in headers so the
      // backend stays a single, dependency-free upload path. No explicit
      // content-type — the browser sets it from the File.
      const headers: Record<string, string> = { 'x-kip-filename': encodeURIComponent(file.name) };
      if (meta.title) headers['x-kip-title'] = encodeURIComponent(meta.title);
      if (meta.description) headers['x-kip-description'] = encodeURIComponent(meta.description);
      return call<KipSource>(`/v1/projects/${projectId}/sources/file`, { method: 'POST', headers, body: file });
    },

    listConnections: (projectId: string) => call<ExternalConnection[]>(`/v1/projects/${projectId}/connections`),
    listConnectionItems: (projectId: string, provider: string) =>
      call<ExternalItem[]>(`/v1/projects/${projectId}/connections/${provider}/items`),
    registerExternalSource: (
      projectId: string,
      provider: string,
      body: { itemId: string; itemType: string; name: string; uri?: string; detail?: string },
    ) => call<KipSource>(`/v1/projects/${projectId}/sources/${provider}`, json('POST', body)),

    /** Returns the GitHub install URL the browser must be navigated to. */
    startGitHubConnect: (projectId: string) =>
      call<{ url: string }>(`/v1/projects/${projectId}/connections/github/start`, json('POST', {})),
    /** Repositories actually granted to the project's GitHub installation. */
    listGitHubRepositories: (projectId: string) =>
      call<ExternalItem[]>(`/v1/projects/${projectId}/connections/github/repositories`),
    /** Canonical documents for a source (latest completed ingestion by default). */
    listSourceDocuments: (projectId: string, sourceId: string) =>
      call<{ ingestionId: string | null; documents: DocumentView[] }>(
        `/v1/projects/${projectId}/sources/${sourceId}/documents`,
      ),
    getDocument: (projectId: string, documentId: string) =>
      call<DocumentView>(`/v1/projects/${projectId}/documents/${documentId}`),
    /** Canonical chunks of one document (position, context and a short preview). */
    listDocumentChunks: (projectId: string, documentId: string) =>
      call<{ documentId: string; chunkCount: number; chunks: ChunkView[] }>(
        `/v1/projects/${projectId}/documents/${documentId}/chunks`,
      ),
    getChunk: (projectId: string, chunkId: string) =>
      call<ChunkView>(`/v1/projects/${projectId}/chunks/${chunkId}`),
    /** Latest ingestion job per source for the active project. */
    listProjectIngestions: (projectId: string) => call<IngestionJobView[]>(`/v1/projects/${projectId}/ingestions`),
    /** Process a source (safe to call twice: an active job is reused, not duplicated). */
    startIngestion: (projectId: string, sourceId: string) =>
      call<{ job: IngestionJobView; reused: boolean; reason?: string }>(
        `/v1/projects/${projectId}/sources/${sourceId}/ingestions`,
        json('POST', {}),
      ),
    retryIngestion: (projectId: string, ingestionId: string) =>
      call<{ job: IngestionJobView; reused: boolean }>(`/v1/projects/${projectId}/ingestions/${ingestionId}/retry`, json('POST', {})),
    disconnectGitHub: (projectId: string) =>
      call<{ provider: string; status: string }>(`/v1/projects/${projectId}/connections/github`, {
        method: 'DELETE',
      }),
  };
}
