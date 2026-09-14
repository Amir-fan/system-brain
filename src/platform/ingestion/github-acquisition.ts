/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-012
 * @purpose GitHub acquisition adapter: repository text files -> combined payload.
 *
 * Uses the EXISTING project-scoped GitHub App installation: the installation is
 * resolved from external_connections, an installation access token is minted on
 * demand (memory only, never persisted/logged/returned), and content is read via
 * the GitHub API at the reference's default branch. No PAT, no clone, no crawl.
 */

import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';
import type { AcquiredContent } from '../../core/ingestion/ingestion.types.ts';
import type { IngestionSourceReader, SourceAcquisitionAdapter } from '../../core/ingestion/ingestion.ports.ts';
import type { ExternalConnectionStorage } from '../provider/external-connection.storage.ts';
import type { GitHubAppAuth } from '../github/github-app.ts';

export const GITHUB_ACQUISITION_LIMITS = {
  maxFiles: 40,
  maxFileBytes: 200_000,
  maxTotalBytes: 2_000_000,
} as const;

/** Text formats K11 can acquire deterministically. */
export const GITHUB_TEXT_EXTENSIONS = [
  'md', 'mdx', 'txt', 'rst', 'json', 'yaml', 'yml', 'toml', 'csv',
  'ts', 'tsx', 'js', 'jsx', 'py', 'sql',
] as const;

/** Directories that never contribute knowledge content. */
export const GITHUB_EXCLUDED_DIRS = [
  'node_modules/', 'vendor/', 'dist/', 'build/', '.git/', '.next/', 'coverage/', 'out/', '__pycache__/',
] as const;

/** Files that must never be acquired, whatever their extension. */
export const GITHUB_SECRET_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)id_ed25519/i,
  /(^|\/)credentials(\..*)?$/i,
  /(^|\/)secrets?(\..*)?$/i,
  /\.keystore$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
] as const;

/** Dependency lockfiles: large, generated, no knowledge value for V1. */
export const GITHUB_LOCKFILES = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)bun\.lockb?$/i,
  /(^|\/)Gemfile\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)composer\.lock$/i,
] as const;

export function isLockfilePath(path: string): boolean {
  return GITHUB_LOCKFILES.some((pattern) => pattern.test(path));
}

export function isSecretLikePath(path: string): boolean {
  return GITHUB_SECRET_PATTERNS.some((pattern) => pattern.test(path));
}

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
}

const depthOf = (path: string) => path.split('/').length;

/**
 * Deterministic, explainable selection of knowledge files from a repo tree.
 * Dot-directories (.agents, .github, .claude, ...) are tooling/config, so they
 * are skipped; remaining paths are ordered shallow-first so that top-level
 * knowledge files (README, docs/) win when the file cap truncates the result.
 */
export function selectAcquirablePaths(paths: string[]): string[] {
  return paths
    .filter((p) => !p.split('/').some((segment) => segment.startsWith('.')))
    .filter((p) => !GITHUB_EXCLUDED_DIRS.some((dir) => p.toLowerCase().includes(dir)))
    .filter((p) => !isSecretLikePath(p))
    .filter((p) => !isLockfilePath(p))
    .filter((p) => (GITHUB_TEXT_EXTENSIONS as readonly string[]).includes(extensionOf(p)))
    .sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** K11 combined representation - a bounded acquisition payload, not Documents. */
export function combineFiles(files: Array<{ path: string; text: string }>): string {
  return files.map((f) => `--- FILE: ${f.path} ---\n${f.text}`).join('\n\n');
}

export interface GithubAcquisitionDeps {
  sources: IngestionSourceReader;
  /** Resolves the project's GitHub installation and the source's repo reference. */
  connections: ExternalConnectionStorage;
  app: GitHubAppAuth;
  fetchImpl?: typeof fetch;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

interface TreeEntry {
  path?: string;
  type?: string;
  size?: number;
  sha?: string;
}

export function createGitHubAcquisitionAdapter(deps: GithubAcquisitionDeps): SourceAcquisitionAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxFiles = deps.maxFiles ?? GITHUB_ACQUISITION_LIMITS.maxFiles;
  const maxFileBytes = deps.maxFileBytes ?? GITHUB_ACQUISITION_LIMITS.maxFileBytes;
  const maxTotalBytes = deps.maxTotalBytes ?? GITHUB_ACQUISITION_LIMITS.maxTotalBytes;

  return {
    sourceTypes: ['github'],
    async acquire({ projectId, sourceId }): Promise<AcquiredContent> {
      const connection = await deps.connections.getConnection(projectId, 'github');
      if (!connection || connection.status !== 'connected' || !connection.accountId) {
        throw new IngestionFailure('GITHUB_NOT_CONNECTED');
      }
      const reference = await deps.connections.getReferenceBySource(projectId, sourceId);
      const fullName = reference?.displayName ?? '';
      const branch = reference?.externalPath || 'main';
      if (!fullName.includes('/')) throw new IngestionFailure('GITHUB_ACQUISITION_FAILED');

      // Installation token: minted on demand for this call only.
      let token: string;
      try {
        token = await deps.app.installationToken(connection.accountId);
      } catch {
        throw new IngestionFailure('GITHUB_ACQUISITION_FAILED');
      }

      const api = (path: string) =>
        fetchImpl('https://api.github.com' + path, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'kip-next',
            authorization: 'Bearer ' + token,
          },
        });

      const treeRes = await api(`/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (!treeRes.ok) throw new IngestionFailure('GITHUB_ACQUISITION_FAILED');
      const tree = (await treeRes.json()) as { tree?: TreeEntry[] };
      const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob' && typeof e.path === 'string');
      const candidates = selectAcquirablePaths(blobs.map((e) => e.path as string));
      if (candidates.length === 0) throw new IngestionFailure('GITHUB_ACQUISITION_FAILED');

      const byPath = new Map(blobs.map((e) => [e.path as string, e]));
      const files: Array<{ path: string; text: string }> = [];
      let totalBytes = 0;
      let truncated = false;

      for (const path of candidates) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        const entry = byPath.get(path);
        const declaredSize = entry?.size ?? 0;
        if (declaredSize > maxFileBytes) {
          truncated = true;
          continue;
        }
        if (totalBytes + declaredSize > maxTotalBytes) {
          truncated = true;
          break;
        }

        // GitHub API content read (never an unauthenticated raw URL).
        const blobRes = await api(`/repos/${fullName}/git/blobs/${entry?.sha ?? ''}`);
        if (!blobRes.ok) continue;
        const blob = (await blobRes.json()) as { content?: string; encoding?: string };
        if (!blob.content || blob.encoding !== 'base64') continue;

        const bytes = Buffer.from(blob.content, 'base64');
        if (bytes.length > maxFileBytes) {
          truncated = true;
          continue;
        }
        if (totalBytes + bytes.length > maxTotalBytes) {
          truncated = true;
          break;
        }
        totalBytes += bytes.length;
        files.push({ path, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) });
      }

      if (files.length === 0) throw new IngestionFailure('GITHUB_ACQUISITION_FAILED');

      return {
        sourceId,
        sourceType: 'github',
        contentType: 'text/plain',
        text: combineFiles(files),
        // One unit per repository file: the K12 canonical Documents are derived
        // from these units, so file boundaries never depend on re-parsing a blob.
        units: files.map((file) => ({
          key: 'github:' + file.path,
          title: file.path.slice(file.path.lastIndexOf('/') + 1),
          logicalPath: file.path,
          contentType: 'text/plain' as const,
          text: file.text,
        })),
        provenance: {
          kind: 'github',
          detail: fullName,
          fileCount: files.length,
          byteCount: totalBytes,
          ...(truncated ? { truncated: true } : {}),
        },
      };
    },
  };
}
