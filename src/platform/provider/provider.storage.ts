/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-005
 * @purpose Minimal provider-config + Vault secret storage repository (platform-level).
 *
 * Uses Supabase Vault (verified available: supabase_vault 0.3.1) via SECURITY
 * INVOKER public wrappers (kip_vault_*). provider_configs holds only reference
 * metadata and a masked hint — never the secret. Server-side only.
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';

export type ProviderConnectionStatus = 'connected' | 'failed' | 'not_configured';

export interface ProviderConfigRecord {
  id: string;
  providerKey: string;
  connectionStatus: ProviderConnectionStatus;
  credentialConfigured: boolean;
  maskedKey?: string;
  lastTestedAt?: string;
}

export interface ProviderStorage {
  getProvider(providerKey: string): Promise<ProviderConfigRecord | null>;
  listProviders(): Promise<ProviderConfigRecord[]>;
  saveProviderSecret(providerKey: string, secret: string, displayName?: string): Promise<ProviderConfigRecord>;
  readSecret(providerKey: string): Promise<string | null>;
  setConnectionStatus(providerKey: string, status: ProviderConnectionStatus, lastTestedAt?: string): Promise<void>;
  revokeCredential(providerKey: string): Promise<void>;
}

/** Mask a raw key for display: keep prefix + last 4 chars, redact the middle. */
export function maskKey(raw: string): string {
  if (raw.length <= 8) return '••••••••';
  return `${raw.slice(0, 3)}-••••${raw.slice(-4)}`;
}

const secretRef = (providerKey: string) => `kip:provider:${providerKey}`;

export function createProviderStorage(db: SupabaseDatabase): ProviderStorage {
  const rowToRecord = (r: Record<string, unknown>): ProviderConfigRecord => ({
    id: r.id as string,
    providerKey: r.provider_key as string,
    connectionStatus: r.connection_status as ProviderConnectionStatus,
    credentialConfigured: r.credential_configured as boolean,
    maskedKey: (r.masked_key as string) ?? undefined,
    lastTestedAt: (r.last_tested_at as string) ?? undefined,
  });

  const getByKey = async (providerKey: string) => {
    const { data } = await db
      .from('provider_configs')
      .select('id, provider_key, connection_status, credential_configured, masked_key, last_tested_at')
      .eq('provider_key', providerKey)
      .maybeSingle();
    return data ? rowToRecord(data) : null;
  };

  return {
    async getProvider(providerKey) {
      return getByKey(providerKey);
    },
    async listProviders() {
      const { data } = await (db
        .from('provider_configs')
        .select('id, provider_key, connection_status, credential_configured, masked_key, last_tested_at') as unknown as Promise<{
        data: Array<Record<string, unknown>> | null;
      }>);
      return (data ?? []).map(rowToRecord);
    },
    async saveProviderSecret(providerKey, secret, displayName) {
      const name = secretRef(providerKey);
      const existingConfig = await getByKey(providerKey);
      // Ensure secret exists before wiring config.
      await db.rpc('kip_vault_delete_secret', { p_name: name });
      const { error: secErr } = await db.rpc('kip_vault_create_secret', { p_name: name, p_value: secret });
      if (secErr) throw new Error('vault secret store failed');

      const upsert = existingConfig
        ? (db
            .from('provider_configs')
            .update({
              connection_status: 'connected',
              credential_configured: true,
              masked_key: maskKey(secret),
              secure_secret_reference: name,
              updated_at: new Date().toISOString(),
              ...(displayName ? { display_name: displayName } : {}),
            })
            .eq('provider_key', providerKey) as unknown as Promise<unknown>)
        : (db
            .from('provider_configs')
            .insert({
              provider_key: providerKey,
              display_name: displayName ?? null,
              connection_status: 'connected',
              credential_configured: true,
              masked_key: maskKey(secret),
              secure_secret_reference: name,
            }) as unknown as Promise<unknown>);
      const { error: cfgErr } = (await upsert) as { error?: unknown };
      if (cfgErr) throw new Error('provider config write failed');

      const fresh = await getByKey(providerKey);
      if (!fresh) throw new Error('provider config write failed');
      return fresh;
    },
    async readSecret(providerKey) {
      const { data } = await db.rpc('kip_vault_read_secret', { p_name: secretRef(providerKey) });
      return (data as string | null) ?? null;
    },
    async setConnectionStatus(providerKey, status, lastTestedAt) {
      const patch: Record<string, unknown> = { connection_status: status };
      if (lastTestedAt !== undefined) patch.last_tested_at = lastTestedAt;
      await db.from('provider_configs').update(patch).eq('provider_key', providerKey);
    },
    async revokeCredential(providerKey) {
      const existing = await getByKey(providerKey);
      await db.rpc('kip_vault_delete_secret', { p_name: secretRef(providerKey) });
      if (existing) {
        await db
          .from('provider_configs')
          .update({
            connection_status: 'not_configured',
            credential_configured: false,
            masked_key: null,
            secure_secret_reference: null,
          })
          .eq('provider_key', providerKey);
      } else {
        await db
          .from('provider_configs')
          .insert({ provider_key: providerKey, connection_status: 'not_configured', credential_configured: false });
      }
    },
  };
}