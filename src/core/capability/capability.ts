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

/** K0 registrations are code-based, not DB-backed. No dispatcher in Step 1. */
export type CapabilityRegistry = Record<CapabilityKey, CapabilityHandler>;

/** Port a runtime/executor consumes to resolve a capability by key. */
export interface CapabilityLookup {
  get(key: CapabilityKey): Promise<CapabilityHandler | undefined>;
}