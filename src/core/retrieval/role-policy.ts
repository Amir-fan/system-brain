/**
 * @kip
 * @module role-policy
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-004
 * @purpose K17 progressive source-role retrieval policy: search the narrowest role
 *          scope first and broaden ONLY when the evidence is insufficient.
 *
 * Thin, deterministic policy around the existing K15 retrieval service — no second
 * engine, no LLM, no new confidence model. It reuses the K15-calibrated semantic
 * signal (best raw semantic cosine vs the measured floor) to answer one question:
 * "is current evidence sufficient to stop expanding the source scope?"
 *
 * ROLE = SEARCH PRIORITY, NOT TRUTH. The policy only ever BROADENS scope; it never
 * removes evidence or lets a higher-priority role suppress a contradiction.
 */

export type RetrievalStage = 'primary' | 'primary_supporting' | 'all';

export const RETRIEVAL_ROLE_ORDER = ['primary', 'supporting', 'reference'] as const;

export interface ProgressiveRetrievalDeps {
  /** Roles that actually have at least one source in this project. */
  availableRoles: ReadonlySet<string>;
  /** Runs existing retrieval over the role set; returns best raw semantic score. */
  search: (roles: string[]) => Promise<{ semanticTop: number | null }>;
  /** Measured semantic floor (K16). At/above → sufficient to stop expanding. */
  semanticFloor: number;
}

export interface ProgressiveOutcome {
  retrievalStage: RetrievalStage;
  sourceRolesUsed: string[];
  semanticTop: number | null;
  stagesTried: RetrievalStage[];
}

const STAGE_PLAN: { stage: RetrievalStage; roles: string[] }[] = [
  { stage: 'primary', roles: ['primary'] },
  { stage: 'primary_supporting', roles: ['primary', 'supporting'] },
  { stage: 'all', roles: ['primary', 'supporting', 'reference'] },
];

/**
 * Runs the progressive role policy. Stages whose roles do not exist are skipped, so
 * a project with no primary sources degrades straight to the next available stage and
 * a project with no roles still performs exactly one retrieval (knowledge never
 * disappears because a role is absent).
 */
export async function progressiveRetrieve(deps: ProgressiveRetrievalDeps): Promise<ProgressiveOutcome> {
  const stagesTried: RetrievalStage[] = [];
  let lastRoles: string[] = [];
  let lastStage: RetrievalStage = 'all';
  let lastSemanticTop: number | null = null;
  let lastScopeKey: string | null = null;

  for (const plan of STAGE_PLAN) {
    const active = plan.roles.filter((role) => deps.availableRoles.has(role));
    if (active.length === 0) continue; // grace: skip a stage whose roles are absent
    const scopeKey = active.join(',');
    if (scopeKey === lastScopeKey) continue; // never repeat an identical scope

    stagesTried.push(plan.stage);
    lastScopeKey = scopeKey;
    lastRoles = active;
    lastStage = plan.stage;
    const { semanticTop } = await deps.search(active);
    lastSemanticTop = semanticTop;
    if (semanticTop !== null && semanticTop >= deps.semanticFloor) {
      return { retrievalStage: plan.stage, sourceRolesUsed: active, semanticTop, stagesTried };
    }
  }

  return { retrievalStage: lastStage, sourceRolesUsed: lastRoles, semanticTop: lastSemanticTop, stagesTried };
}