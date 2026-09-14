/**
 * Canonical authenticated KIP API client.
 * Attaches the current Supabase access token as `Authorization: Bearer <token>`.
 * Never receives or stores the platform admin token.
 */
import { supabase } from '../lib/supabase';

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error('not authenticated');
  return data.session.access_token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error('تعذر الوصول إلى الخادم — تأكد من أن الخادم يعمل وحاول مجددًا.');
  }
  // Guard against non-JSON responses (e.g. an SPA fallback returning index.html):
  // without this the caller would receive `undefined` and could crash on render.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('رد غير متوقع من الخادم — تأكد من أن واجهة KIP البرمجية تعمل.');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; data?: T };
  if (!res.ok) {
    const msg = body.error?.message ?? `request failed (${res.status})`;
    if (res.status === 401) throw new Error('انتهت الجلسة — سجّل الدخول مرة أخرى.');
    if (res.status === 403) throw new Error('ليس لديك صلاحية لهذا المشروع.');
    throw new Error(msg);
  }
  return (body as { data: T }).data;
}

export interface ActorProject {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'service';
  status: string;
}

export interface KipSource {
  id: string;
  sourceType: string;
  title: string;
  description?: string;
  externalUri: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CreateSourceInput {
  sourceType: 'url';
  title: string;
  description?: string;
  externalUri: string;
}

export function apiKip() {
  return {
    myProjects: () => request<ActorProject[]>('/v1/projects'),
    listSources: (projectId: string) => request<KipSource[]>(`/v1/projects/${projectId}/sources`),
    getSource: (projectId: string, sourceId: string) => request<KipSource>(`/v1/projects/${projectId}/sources/${sourceId}`),
    createSource: (projectId: string, body: CreateSourceInput) =>
      request<KipSource>(`/v1/projects/${projectId}/sources`, { method: 'POST', body: JSON.stringify(body) }),
    updateSource: (projectId: string, sourceId: string, body: { title?: string; description?: string; externalUri?: string }) =>
      request<KipSource>(`/v1/projects/${projectId}/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    archiveSource: (projectId: string, sourceId: string) =>
      request<KipSource>(`/v1/projects/${projectId}/sources/${sourceId}`, { method: 'DELETE' }),
  };
}