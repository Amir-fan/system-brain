/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-009
 * @purpose Raw Artifact persistence — the ORIGINAL knowledge material KIP owns.
 *
 * A raw artifact is the original uploaded file or pasted text. It is NOT a
 * Document, Chunk, Embedding, or any ingestion result: extraction/normalization
 * belongs to a future Ingestion slice. One artifact per source (schema-enforced).
 */

import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';

export type RawArtifactKind = 'file' | 'text';

export interface RawArtifactRecord {
  id: string;
  projectId: string;
  sourceId: string;
  kind: RawArtifactKind;
  originalName?: string;
  mimeType?: string;
  byteSize?: number;
  contentSha256?: string;
  storageBucket?: string;
  storagePath?: string;
  textContent?: string;
}

export interface CreateTextArtifactInput {
  projectId: string;
  sourceId: string;
  textContent: string;
  contentSha256?: string;
}

export interface CreateFileArtifactInput {
  projectId: string;
  sourceId: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  contentSha256?: string;
  storageBucket: string;
  storagePath: string;
}

export interface RawArtifactStorage {
  createText(input: CreateTextArtifactInput): Promise<RawArtifactRecord>;
  createFile(input: CreateFileArtifactInput): Promise<RawArtifactRecord>;
  getBySource(projectId: string, sourceId: string): Promise<RawArtifactRecord | null>;
  /** Metadata only — deliberately never returns text_content for list views. */
  listMetadataByProject(projectId: string): Promise<RawArtifactRecord[]>;
  deleteBySource(projectId: string, sourceId: string): Promise<void>;
}

const COLUMNS =
  'id, project_id, source_id, kind, original_name, mime_type, byte_size, content_sha256, storage_bucket, storage_path, created_at';
const COLUMNS_WITH_TEXT = COLUMNS + ', text_content';

const mapRow = (r: Record<string, unknown>): RawArtifactRecord => ({
  id: r.id as string,
  projectId: r.project_id as string,
  sourceId: r.source_id as string,
  kind: r.kind as RawArtifactKind,
  originalName: (r.original_name as string) ?? undefined,
  mimeType: (r.mime_type as string) ?? undefined,
  byteSize: r.byte_size === null || r.byte_size === undefined ? undefined : Number(r.byte_size),
  contentSha256: (r.content_sha256 as string) ?? undefined,
  storageBucket: (r.storage_bucket as string) ?? undefined,
  storagePath: (r.storage_path as string) ?? undefined,
  textContent: (r.text_content as string) ?? undefined,
});

export function createRawArtifactStorage(db: SupabaseDatabase): RawArtifactStorage {
  const getById = async (projectId: string, sourceId: string) => {
    const { data } = await db
      .from('raw_artifacts')
      .select(COLUMNS_WITH_TEXT)
      .eq('project_id', projectId)
      .eq('source_id', sourceId)
      .maybeSingle();
    return data ? mapRow(data) : null;
  };

  const insert = async (row: Record<string, unknown>): Promise<RawArtifactRecord> => {
    const { error } = (await db.from('raw_artifacts').insert(row)) as unknown as { error?: unknown };
    if (error) throw new Error('raw artifact write failed');
    const fresh = await getById(row.project_id as string, row.source_id as string);
    if (!fresh) throw new Error('raw artifact write failed');
    return fresh;
  };

  return {
    createText(input) {
      return insert({
        project_id: input.projectId,
        source_id: input.sourceId,
        kind: 'text',
        text_content: input.textContent,
        content_sha256: input.contentSha256 ?? null,
        mime_type: 'text/plain',
      });
    },
    createFile(input) {
      return insert({
        project_id: input.projectId,
        source_id: input.sourceId,
        kind: 'file',
        original_name: input.originalName,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        content_sha256: input.contentSha256 ?? null,
        storage_bucket: input.storageBucket,
        storage_path: input.storagePath,
      });
    },
    getBySource(projectId, sourceId) {
      return getById(projectId, sourceId);
    },
    async listMetadataByProject(projectId) {
      const { data } = await db.from('raw_artifacts').select(COLUMNS).eq('project_id', projectId).limit(1000);
      return (data ?? []).map(mapRow);
    },
    async deleteBySource(projectId, sourceId) {
      await db.from('raw_artifacts').delete().eq('project_id', projectId).eq('source_id', sourceId);
    },
  };
}
