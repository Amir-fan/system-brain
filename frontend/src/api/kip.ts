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
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; data?: T };
  if (!res.ok) throw new Error(body.error?.message ?? `request failed (${res.status})`);
  return (body as { data: T }).data;
}

export interface ActorProject {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'service';
  status: string;
}

export function apiKip() {
  return {
    myProjects: () => request<ActorProject[]>('/v1/projects'),
    listSources: (projectId: string) => request<unknown[]>(`/v1/projects/${projectId}/sources`),
    createSource: (projectId: string, body: unknown) => request(`/v1/projects/${projectId}/sources`, { method: 'POST', body: JSON.stringify(body) }),
  };
}