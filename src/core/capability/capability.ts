/**
 * @kip
 * @module capability
 * @layer core
 * @owner platform-core
 * @feature K0-001
 * @purpose Canonical Capability contract surface (contract only; no dispatcher yet).
 */

/** A generic invocable ability exposed through KIP Runtime, e.g. `platform.test`. */
export type CapabilityKey = string;

export interface CapabilityInput {
  projectId: string;
  capability: CapabilityKey;
  input: unknown;
}

/** A single capability implementation signature. Registration only, in code. */
export type CapabilityHandler = (input: CapabilityInput) => Promise<unknown>;

/**
 * K0 registrations are code-based, not DB-backed: a capability is a key whose
 * handler is registered in code. No dispatcher is implemented in K0; Runtime
 * orchestration that resolves a key to an implementation belongs in Step 2.
 *
 * Future path preserved (not implemented): Runtime -> Capability -> Skill
 * Runtime -> Skill. A Skill Runtime registers handlers here without Core
 * knowing Skill internals.
 */
export type CapabilityRegistry = Record<CapabilityKey, CapabilityHandler>;