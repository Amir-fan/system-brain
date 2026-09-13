/**
 * @kip
 * @module capability
 * @layer core
 * @owner platform-core
 * @feature K0-002
 * @purpose Small concrete code-based capability dispatcher (explicit registrations only).
 */

import type { CapabilityHandler, CapabilityKey, CapabilityLookup } from './capability.ts';

/**
 * Explicit, typed capability dispatcher. No dynamic loading, no reflection,
 * no DB registry. Unknown keys resolve to undefined and are rejected by Runtime.
 */
export class MapCapabilityRegistry implements CapabilityLookup {
  private readonly handlers = new Map<CapabilityKey, CapabilityHandler>();

  register(key: CapabilityKey, handler: CapabilityHandler): void {
    this.handlers.set(key, handler);
  }

  async get(key: CapabilityKey): Promise<CapabilityHandler | undefined> {
    return this.handlers.get(key);
  }
}