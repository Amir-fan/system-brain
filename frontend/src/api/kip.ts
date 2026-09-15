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
import { call, json } from './transport';
export { call, json };

// ---------------------------------------------------------------- contracts

export interface ActorProject {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'service';
  status: string;
}

export type SourceType = 'url' | 'file' | 'text' | 'github' | 'google_drive';

/** K17 SourceRole — retrieval-policy metadata only (how the project uses the source). */
export type SourceRole = 'primary' | 'supporting' | 'reference';

export interface KipSource {
  id: string;
  sourceType: SourceType;
  title: string;
  description?: string;
  externalUri?: string;
  status: string;
  role: SourceRole;
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

export type IndexState = 'ready' | 'partial' | 'none' | 'indexing';

/** Two separate concepts: content readiness (ingestion) and index readiness. */
export interface IndexStatusView {
  content: { ready: boolean; chunkCount: number };
  index: {
    state: IndexState;
    modelId: string | null;
    modelMatches: boolean;
    embeddedChunks: number;
    totalChunks: number;
  };
  job: {
    id: string;
    status: string;
    chunksRequested: number;
    chunksEmbedded: number;
    chunksReused: number;
    batchCount: number;
    failedAt?: string;
    errorCode?: string;
    errorMessage?: string;
  } | null;
}

export type AnswerStatus = 'answered' | 'insufficient_evidence' | 'conflicting_evidence' | 'needs_clarification';
export interface AnswerEvidenceView {
  label: string;
  sourceTitle: string | null;
  documentTitle: string | null;
  logicalPath: string | null;
  headingContext: string | null;
  excerpt: string;
}
export interface KnowledgeAnswerView {
  status: AnswerStatus;
  answer: string | null;
  message: string | null;
  clarification: { question: string; choices?: string[] } | null;
  confidence: string;
  evidence: AnswerEvidenceView[];
}

export interface RetrievalHitView {
  position: number;
  text: string;
  source: string | null;
  document: string | null;
  logicalPath: string | null;
  headingContext: string | null;
  score: number;
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
    updateSource: (projectId: string, sourceId: string, body: { title?: string; description?: string; externalUri?: string; role?: SourceRole }) =>
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
    /** Ranked evidence for a query (no answer generation, no vectors). */
    /** Evidence-grounded answer to one question (no memory, no chatbot). */
    askKnowledge: (projectId: string, body: { question: string; language?: 'ar' | 'en' }) =>
      call<KnowledgeAnswerView>(`/v1/projects/${projectId}/knowledge/answer`, json('POST', body)),
    searchKnowledge: (
      projectId: string,
      body: { query: string; topK?: number; sourceIds?: string[]; documentIds?: string[] },
    ) =>
      call<{ query: string; resultCount: number; results: RetrievalHitView[] }>(
        `/v1/projects/${projectId}/retrieval/search`,
        json('POST', body),
      ),
    /** Content readiness + index readiness for one source (no vectors, no internals). */
    indexStatus: (projectId: string, sourceId: string) =>
      call<IndexStatusView>(`/v1/projects/${projectId}/sources/${sourceId}/embeddings`),
    /** Explicit indexing / reindexing of the latest processed content. */
    indexSourceKnowledge: (projectId: string, sourceId: string) =>
      call<{ job: unknown; reused: boolean }>(
        `/v1/projects/${projectId}/sources/${sourceId}/embeddings`,
        json('POST', {}),
      ),
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
