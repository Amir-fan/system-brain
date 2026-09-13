/**
 * @kip
 * @module project
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Canonical Project entity and status contract.
 */

export type ProjectId = string;

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface Project {
  id: ProjectId;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}