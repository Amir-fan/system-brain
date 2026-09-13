/**
 * @kip
 * @module authorization
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Canonical Actor and project-membership authorization contracts.
 */

/** Actor is the canonical acting principal. No Principal/IdentitySubject synonym. */
export type Actor = string;

export const ROLES = ['owner', 'member', 'service'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Trusted runtime/auth context carried with a run.
 * Never derived from an arbitrary actorSubject sent by a public client.
 */
export interface AuthorizationContext {
  actor: Actor;
  role: Role;
}

export interface ProjectMembership {
  projectId: string;
  actor: Actor;
  role: Role;
  createdAt: string;
}