/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @purpose Shared transport for the canonical authenticated KIP API client.
 * Reuses the refresh-once/retry-once session rule; normalizes failures.
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
    if (res.status === 401) return { status: 401, body: {} };
    throw new Error(UNEXPECTED_RESPONSE);
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Body<T> };
}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await runWithSessionRetry(createSessionPorts(), (token) => attempt<T>(path, init, token));
  if (res.status >= 400) {
    if (res.status === 403) throw new Error(FORBIDDEN);
    if (res.status === 404) throw new Error(res.body.error?.message ?? 'العنصر غير موجود.');
    throw new Error(res.body.error?.message ?? `فشل الطلب (${res.status})`);
  }
  return res.body.data as T;
}

export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});