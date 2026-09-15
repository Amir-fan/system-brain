/**
 * @kip
 * @module skill
 * @layer core
 * @owner intelligence-knowledge
 * @feature K20
 * @purpose Small code-backed Skill Registry: register / get / list.
 *
 * In-process for V1 — no database, no marketplace, no dynamic code. Stable identity
 * (id) + explicit version so future replacements do not require a contract redesign.
 */

import type { SkillDefinition } from './skill.ts';

export interface SkillRegistry {
  register(skill: SkillDefinition): void;
  get(skillId: string): SkillDefinition | undefined;
  list(): SkillDefinition[];
}

export class MapSkillRegistry implements SkillRegistry {
  private readonly byId = new Map<string, SkillDefinition>();

  /** Register or replace; duplicate id+version is an error (prevents accidental shadowing). */
  register(skill: SkillDefinition): void {
    const existing = this.byId.get(skill.id);
    if (existing && existing.version === skill.version) {
      throw new Error(`skill already registered: ${skill.id}@${skill.version}`);
    }
    this.byId.set(skill.id, skill);
  }

  get(skillId: string): SkillDefinition | undefined {
    return this.byId.get(skillId);
  }

  list(): SkillDefinition[] {
    return [...this.byId.values()];
  }
}
