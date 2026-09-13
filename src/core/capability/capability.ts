/**
 * @kip
 * @module capability
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Canonical Capability contract and code-based registration surface.
 */

/** A generic invocable ability exposed through KIP Runtime, e.g. `platform.test`. */
export type CapabilityKey = string;

export interface CapabilityInput {
  projectId: string;
  capability: CapabilityKey;
  input: unknown;
}

/**
 * Generic capability handler. A future Skill Runtime may register handlers here
 * so Skills are reached through Capabilities without Core knowing Skill internals.
 */
export type CapabilityHandler = (input: CapabilityInput) => Promise<unknown>;

/** K0 registrations are code-based, not DB-backed. */
export type CapabilityRegistry = Record<CapabilityKey, CapabilityHandler>;