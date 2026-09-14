/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-009
 * @purpose Provider-neutral External Connection + External Source Reference storage.
 *
 * GitHub and Google Drive share ONE connection concept (no two credential
 * architectures). Credentials are NEVER stored here: only a Vault secret
 * reference. Revoking a connection sets the reference's connection_id to NULL so
 * historical Source identity survives a disconnect.
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import type { SourceType } from './source.storage.ts';

export const EXTERNAL_PROVIDERS = ['github', 'google_drive'] as const;
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number];

export function isExternalProvider(v: unknown): v is ExternalProvider {
  return typeof v === 'string' && (EXTERNAL_PROVIDERS as readonly string[]).includes(v);
}

export type ConnectionStatus = 'connected' | 'not_connected' | 'error';

export interface ExternalConnectionRecord {
  id: string;
  projectId: string;
  provider: ExternalProvider;
  status: ConnectionStatus;
  accountId?: string;
  accountLabel?: string;
}

export interface ExternalReferenceRecord {
  sourceId: string;
  provider: ExternalProvider;
  externalItemId: string;
  externalType: string;
  externalUri?: string;
  displayName?: string;
  externalPath?: string;
  connectionId?: string;
}

export interface CreateExternalReferenceInput {
  projectId: string;
  sourceId: string;
  provider: ExternalProvider;
  connectionId?: string;
  externalItemId: string;
  externalType: string;
  externalUri?: string;
  displayName?: string;
  externalPath?: string;
}

export interface ExternalConnectionStorage {
  listConnections(projectId: string): Promise<ExternalConnectionRecord[]>;
  getConnection(projectId: string, provider: ExternalProvider): Promise<ExternalConnectionRecord | null>;
  readSecret(projectId: string, provider: ExternalProvider): Promise<string | null>;
  /** Records a connection whose secret already lives in Vault. */
  saveConnection(
    projectId: string,
    provider: ExternalProvider,
    input: { accountId?: string; accountLabel?: string; secretRef: string },
  ): Promise<ExternalConnectionRecord>;
  /** Revokes access without touching any source identity. */
  disconnect(projectId: string, provider: ExternalProvider): Promise<void>;

  createReference(input: CreateExternalReferenceInput): Promise<ExternalReferenceRecord>;
  listReferencesByProject(projectId: string): Promise<ExternalReferenceRecord[]>;
  getReferenceBySource(projectId: string, sourceId: string): Promise<ExternalReferenceRecord | null>;
}

const CONN_COLUMNS = 'id, project_id, provider, status, external_account_id, external_account_label';
const REF_COLUMNS =
  'source_id, provider, external_item_id, external_type, external_uri, display_name, external_path, connection_id';

export const connectionSecretRef = (projectId: string, provider: ExternalProvider) =>
  `kip:connection:${provider}:${projectId}`;

const mapConn = (r: Record<string, unknown>): ExternalConnectionRecord => ({
  id: r.id as string,
  projectId: r.project_id as string,
  provider: r.provider as ExternalProvider,
  status: r.status as ConnectionStatus,
  accountId: (r.external_account_id as string) ?? undefined,
  accountLabel: (r.external_account_label as string) ?? undefined,
});

const mapRef = (r: Record<string, unknown>): ExternalReferenceRecord => ({
  sourceId: r.source_id as string,
  provider: r.provider as ExternalProvider,
  externalItemId: r.external_item_id as string,
  externalType: r.external_type as string,
  externalUri: (r.external_uri as string) ?? undefined,
  displayName: (r.display_name as string) ?? undefined,
  externalPath: (r.external_path as string) ?? undefined,
  connectionId: (r.connection_id as string) ?? undefined,
});

export function createExternalConnectionStorage(db: SupabaseDatabase): ExternalConnectionStorage {
  const getConnection = async (projectId: string, provider: ExternalProvider) => {
    const { data } = await db
      .from('external_connections')
      .select(CONN_COLUMNS)
      .eq('project_id', projectId)
      .eq('provider', provider)
      .maybeSingle();
    return data ? mapConn(data) : null;
  };

  return {
    async listConnections(projectId) {
      const { data } = await db.from('external_connections').select(CONN_COLUMNS).eq('project_id', projectId).limit(100);
      return (data ?? []).map(mapConn);
    },
    getConnection,
    async readSecret(projectId, provider) {
      const { data } = await db.rpc('kip_vault_read_secret', { p_name: connectionSecretRef(projectId, provider) });
      return (data as string | null) ?? null;
    },
    async saveConnection(projectId, provider, input) {
      const existing = await getConnection(projectId, provider);
      const patch = {
        status: 'connected' as ConnectionStatus,
        external_account_id: input.accountId ?? null,
        external_account_label: input.accountLabel ?? null,
        secure_secret_reference: input.secretRef,
        updated_at: new Date().toISOString(),
      };
      if (existing) {
        await db.from('external_connections').update(patch).eq('id', existing.id);
      } else {
        await db.from('external_connections').insert({ project_id: projectId, provider, ...patch });
      }
      const fresh = await getConnection(projectId, provider);
      if (!fresh) throw new Error('connection write failed');
      return fresh;
    },
    async disconnect(projectId, provider) {
      const existing = await getConnection(projectId, provider);
      await db.rpc('kip_vault_delete_secret', { p_name: connectionSecretRef(projectId, provider) });
      if (existing) {
        await db
          .from('external_connections')
          .update({
            status: 'not_connected',
            external_account_id: null,
            external_account_label: null,
            secure_secret_reference: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      }
      // References keep their identity: connection_id is cleared by the FK rule.
    },
    async createReference(input) {
      const { error } = (await db.from('external_source_references').insert({
        project_id: input.projectId,
        source_id: input.sourceId,
        connection_id: input.connectionId ?? null,
        provider: input.provider,
        external_item_id: input.externalItemId,
        external_type: input.externalType,
        external_uri: input.externalUri ?? null,
        display_name: input.displayName ?? null,
        external_path: input.externalPath ?? null,
      })) as unknown as { error?: unknown };
      if (error) throw new Error('external reference write failed');
      const fresh = await this.getReferenceBySource(input.projectId, input.sourceId);
      if (!fresh) throw new Error('external reference write failed');
      return fresh;
    },
    async listReferencesByProject(projectId) {
      const { data } = await db
        .from('external_source_references')
        .select(REF_COLUMNS)
        .eq('project_id', projectId)
        .limit(1000);
      return (data ?? []).map(mapRef);
    },
    async getReferenceBySource(projectId, sourceId) {
      const { data } = await db
        .from('external_source_references')
        .select(REF_COLUMNS)
        .eq('project_id', projectId)
        .eq('source_id', sourceId)
        .maybeSingle();
      return data ? mapRef(data) : null;
    },
  };
}

/** Source types backed by an external connection. */
export const isConnectedSourceType = (t: SourceType): t is 'github' | 'google_drive' =>
  t === 'github' || t === 'google_drive';
