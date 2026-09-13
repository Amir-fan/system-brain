/**
 * @kip
 * @module authorization
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Canonical project-boundary authorization primitive.
 *
 * ONE responsibility / ONE canonical path: given a project-resolver + membership
 * resolver, decide whether an actor may operate on a project and enforce minimal
 * role rules. Used by both the Runtime and project-scoped resource handlers
 * (e.g. Source Registry) so the project boundary is never duplicated.
 */

import type { Actor, Role } from './actor.ts';
import type { Project } from '../project/project.ts';
import type { ProjectMembership } from './actor.ts';

export interface ProjectBoundaryReaders {
  getProject(projectId: string): Promise<Project | null>;
  getMembership(projectId: string, actor: Actor): Promise<ProjectMembership | null>;
}

export type BoundaryDecision =
  | { ok: true; project: Project; membership: ProjectMembership }
  | { ok: false; kind: 'not_found' | 'not_active' | 'forbidden'; message: string };

export type OperationKind = 'read' | 'write' | 'manage';

/**
 * Resolve + authorize a trusted actor against a project.
 * - projects must exist and be active
 * - the actor must be a project member
 * - `manage` (destructive: archive) additionally requires owner|service
 */
export async function authorizeProject(
  readers: ProjectBoundaryReaders,
  projectId: string,
  actor: Actor,
  operation: OperationKind,
): Promise<BoundaryDecision> {
  const project = await readers.getProject(projectId);
  if (!project) return { ok: false, kind: 'not_found', message: 'project not found' };
  if (project.status !== 'active') {
    return { ok: false, kind: 'not_active', message: 'project is not active' };
  }
  const membership = await readers.getMembership(projectId, actor);
  if (!membership) return { ok: false, kind: 'forbidden', message: 'actor is not a member' };
  if (operation === 'manage' && membership.role !== 'owner' && membership.role !== 'service') {
    return { ok: false, kind: 'forbidden', message: 'operation requires owner or service role' };
  }
  return { ok: true, project, membership };
}

export type { Role };