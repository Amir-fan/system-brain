import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseRuntimePersistence } from '../../src/platform/supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../../src/platform/supabase/supabase.persistence.ts';
import { RuntimeService } from '../../src/core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../../src/core/capability/capability-registry.ts';
import type { CapabilityHandler } from '../../src/core/capability/capability.ts';

export function liveSupabase(): SupabaseDatabase | null {
  const url = process.env.SUPABASE_URL;
  const serverKey = process.env.SUPABASE_SERVER_KEY;
  if (!url || !serverKey) return null;
  return createClient(url, serverKey) as unknown as SupabaseDatabase;
}

export function liveRuntime(db: SupabaseDatabase, handler?: CapabilityHandler): RuntimeService {
  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', handler ?? (async (input) => input));
  return new RuntimeService(createSupabaseRuntimePersistence(db), registry);
}

export async function createLiveProject(
  db: SupabaseDatabase,
  name: string,
  status = 'active',
): Promise<string> {
  const { data } = await (
    db.from('projects').insert({ name, status }).select('id') as unknown as Promise<{
      data: Array<{ id: string }> | null;
    }>
  );
  if (!data || data.length !== 1) throw new Error('failed to create live project');
  return data[0].id;
}

export async function createLiveMembership(
  db: SupabaseDatabase,
  projectId: string,
  actor: string,
  role = 'member',
): Promise<void> {
  await db.from('project_memberships').insert({ project_id: projectId, actor_subject: actor, role });
}

export async function setLiveProjectStatus(db: SupabaseDatabase, projectId: string, status: string): Promise<void> {
  await db.from('projects').update({ status }).eq('id', projectId);
}

export async function cleanLive(db: SupabaseDatabase, projectIds: string[]): Promise<void> {
  for (const pid of projectIds) {
    await db.from('runs').delete().eq('project_id', pid);
    await db.from('project_memberships').delete().eq('project_id', pid);
    await db.from('projects').delete().eq('id', pid);
  }
}

export async function countLiveRuns(db: SupabaseDatabase, projectId?: string): Promise<number> {
  const q = db.from('runs').select('id').eq('project_id', projectId ?? '');
  const { data } = await (q as unknown as Promise<{ data: Array<Record<string, unknown>> | null }>);
  return Array.isArray(data) ? data.length : 0;
}

export type { SupabaseClient };