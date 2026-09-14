/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-010
 * @purpose GitHub App credentials + token flow (App JWT -> installation token).
 *
 * Credentials are server-side only. Installation access tokens are minted on
 * demand, cached in memory with their expiry, and never persisted, logged, or
 * sent to the browser. The private key is validated (parseable) before use.
 */

import { createPrivateKey, createSign } from 'node:crypto';

export interface GitHubAppConfig {
  appId: string;
  clientId?: string;
  /** Signs connector state (and would sign an OAuth code exchange if used). */
  clientSecret: string;
  /** PEM contents (not a path). */
  privateKeyPem: string;
  slug: string;
  publicApiUrl: string;
}

export interface GitHubInstallation {
  id: string;
  accountLogin?: string;
  accountType?: string;
}

export interface GitHubRepository {
  id: string;
  fullName: string;
  name: string;
  url: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitHubAppAuth {
  installationToken(installationId: string): Promise<string>;
  installation(installationId: string): Promise<GitHubInstallation>;
  listInstallationRepositories(installationId: string): Promise<GitHubRepository[]>;
  installUrl(state: string): string;
}

const GITHUB_API = 'https://api.github.com';

/** True when the key parses as a usable private key. Never leaks the key. */
export function isValidPrivateKey(pem: string): boolean {
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

export function loadGitHubAppConfig(env: Record<string, string | undefined>): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  if (!appId || !clientSecret || !privateKeyPem || !slug) return null;
  if (!isValidPrivateKey(privateKeyPem)) return null;
  return {
    appId,
    clientId: env.GITHUB_APP_CLIENT_ID?.trim(),
    clientSecret,
    privateKeyPem,
    slug,
    publicApiUrl: env.KIP_PUBLIC_API_URL?.trim() || 'http://localhost:8787',
  };
}

/** RS256 App JWT (GitHub allows a maximum of 10 minutes). */
export function createAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export function createGitHubAppAuth(cfg: GitHubAppConfig, fetchImpl: typeof fetch = fetch): GitHubAppAuth {
  // In-memory only, process-scoped. Never written anywhere.
  const tokenCache = new Map<string, CachedToken>();

  const appFetch = (path: string, body?: unknown, token?: string) =>
    fetchImpl(`${GITHUB_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'kip-next',
        authorization: `Bearer ${token ?? createAppJwt(cfg.appId, cfg.privateKeyPem)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const installationToken = async (installationId: string): Promise<string> => {
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - Date.now() > 120_000) return cached.token;

    const res = await appFetch(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {});
    if (!res.ok) throw new Error('github installation token request failed');
    const json = (await res.json()) as { token?: string; expires_at?: string };
    if (!json.token) throw new Error('github installation token missing');
    const expiresAtMs = json.expires_at ? Date.parse(json.expires_at) : Date.now() + 3_300_000;
    tokenCache.set(installationId, { token: json.token, expiresAtMs });
    return json.token;
  };

  return {
    installationToken,
    async installation(installationId) {
      const res = await appFetch(`/app/installations/${encodeURIComponent(installationId)}`);
      if (!res.ok) throw new Error('github installation lookup failed');
      const json = (await res.json()) as { id?: number; account?: { login?: string; type?: string } };
      return {
        id: String(json.id ?? installationId),
        accountLogin: json.account?.login,
        accountType: json.account?.type,
      };
    },
    async listInstallationRepositories(installationId) {
      const token = await installationToken(installationId);
      const res = await appFetch('/installation/repositories?per_page=100', undefined, token);
      if (!res.ok) throw new Error('github repository list failed');
      const json = (await res.json()) as {
        repositories?: Array<{
          id?: number;
          full_name?: string;
          name?: string;
          html_url?: string;
          default_branch?: string;
          private?: boolean;
        }>;
      };
      return (json.repositories ?? []).map((r) => ({
        id: String(r.id ?? ''),
        fullName: r.full_name ?? '',
        name: r.name ?? r.full_name ?? '',
        url: r.html_url ?? '',
        defaultBranch: r.default_branch ?? '',
        private: Boolean(r.private),
      }));
    },
    installUrl(state) {
      return `https://github.com/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(state)}`;
    },
  };
}
