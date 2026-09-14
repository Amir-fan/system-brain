/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @purpose Canonical frontend session-expiry handling.
 *
 * Pure orchestration of the "refresh once, retry once" rule so it can be tested
 * without a browser or Supabase SDK:
 *   request -> 401 (stale access token) -> ONE session refresh -> retry ONCE
 * If the refresh fails, or the retry is still 401, the session is unrecoverable:
 * the caller is told to return to Login. 403 is a permission error and must
 * NEVER trigger a refresh (it would hide authorization failures as expiry).
 */

export const SESSION_EXPIRED_MESSAGE = 'انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.';

export interface SessionPorts {
  /** Current access token (null when there is no session). */
  getToken(): Promise<string | null>;
  /** One refresh attempt; resolves to a fresh token, or null when unrecoverable. */
  refresh(): Promise<string | null>;
  /** Clear local auth state and return the user to Login. */
  onExpired(): void;
}

export interface AttemptResponse<T> {
  status: number;
  body: { data?: T; error?: { message?: string } };
}

export interface AttemptResult<T> {
  status: number;
  body: { data?: T; error?: { message?: string } };
  /** True when a stale token was refreshed and the request was retried. */
  refreshed: boolean;
}

export async function runWithSessionRetry<T>(
  ports: SessionPorts,
  attempt: (token: string) => Promise<AttemptResponse<T>>,
): Promise<AttemptResult<T>> {
  const token = await ports.getToken();
  if (!token) {
    ports.onExpired();
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  let res = await attempt(token);
  if (res.status !== 401) return { ...res, refreshed: false };

  const fresh = await ports.refresh();
  if (!fresh) {
    ports.onExpired();
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  res = await attempt(fresh);
  if (res.status === 401) {
    ports.onExpired();
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }
  return { ...res, refreshed: true };
}
