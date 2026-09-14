/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-009
 * @purpose Private raw-file storage adapter (Supabase Storage, server-mediated).
 *
 * The bucket is PRIVATE and only ever touched with the server credential — the
 * browser never receives storage credentials and no public URL is produced.
 * Path model: {project_id}/{source_id}/{artifact_id}/{safe_filename}
 */

export const RAW_BUCKET = 'kip-raw';

export interface RawStorage {
  upload(key: { projectId: string; sourceId: string; artifactId: string; filename: string }, bytes: Uint8Array, contentType: string): Promise<{ bucket: string; path: string }>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Minimal view of the Supabase Storage API this adapter needs. */
export interface SupabaseStorageClient {
  storage: {
    from(bucket: string): {
      upload(path: string, body: Uint8Array, opts?: { contentType?: string; upsert?: boolean }): Promise<{ error: { message: string } | null }>;
      remove(paths: string[]): Promise<{ error: { message: string } | null }>;
      list(path: string): Promise<{ data: Array<{ name: string }> | null; error: { message: string } | null }>;
    };
  };
}

/** Storage keys must be safe ASCII; the human name is kept in the artifact row. */
export function safeFilename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '');
  return (cleaned || 'file').slice(0, 120);
}

export function rawStoragePath(key: { projectId: string; sourceId: string; artifactId: string; filename: string }): string {
  return `${key.projectId}/${key.sourceId}/${key.artifactId}/${safeFilename(key.filename)}`;
}

export function createSupabaseRawStorage(client: SupabaseStorageClient): RawStorage {
  return {
    async upload(key, bytes, contentType) {
      const path = rawStoragePath(key);
      const { error } = await client.storage.from(RAW_BUCKET).upload(path, bytes, { contentType, upsert: false });
      if (error) throw new Error('raw file upload failed');
      return { bucket: RAW_BUCKET, path };
    },
    async remove(path) {
      await client.storage.from(RAW_BUCKET).remove([path]);
    },
    async exists(path) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      const file = path.slice(path.lastIndexOf('/') + 1);
      const { data } = await client.storage.from(RAW_BUCKET).list(dir);
      return (data ?? []).some((o) => o.name === file);
    },
  };
}
