/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-008
 * @purpose Project discovery handler: authenticated member lists their active projects.
 */

import type { Actor } from '../../core/authorization/actor.ts';
import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';

export interface ActorProject {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'service';
  status: string;
}

export interface ProjectDiscoveryStorage {
  listActiveProjectsForActor(actor: Actor): Promise<ActorProject[]>;
}

export function createProjectDiscoveryStorage(db: SupabaseDatabase): ProjectDiscoveryStorage {
  return {
    async listActiveProjectsForActor(actor) {
      const { data } = await (
        db
          .from('project_memberships')
          .select('project_id, role, projects(name, status)')
          .eq('actor_subject', actor) as unknown as Promise<{
          data: Array<{ project_id: string; role: string; projects: { name: string; status: string } | null }> | null;
        }>
      );
      const result: ActorProject[] = [];
      for (const row of data ?? []) {
        // Only return active projects the actor is a member of.
        if (!row.projects || row.projects.status !== 'active') continue;
        result.push({ id: row.project_id, name: row.projects.name, role: row.role as ActorProject['role'], status: row.projects.status });
      }
      return result;
    },
  };
}

export type ProjectListApiResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; status: number; error: { message: string; category: string } };

export async function handleListMyProjects(storage: ProjectDiscoveryStorage, actor: Actor): Promise<ProjectListApiResult> {
  const projects = await storage.listActiveProjectsForActor(actor);
  return { ok: true, status: 200, data: projects };
}