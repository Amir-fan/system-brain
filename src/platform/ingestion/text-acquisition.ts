/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-011
 * @purpose Text acquisition adapter: reads the original pasted text artifact.
 */

import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';
import type { AcquiredContent } from '../../core/ingestion/ingestion.types.ts';
import type { IngestionSourceReader, SourceAcquisitionAdapter } from '../../core/ingestion/ingestion.ports.ts';

export function createTextAcquisitionAdapter(sources: IngestionSourceReader): SourceAcquisitionAdapter {
  return {
    sourceTypes: ['text'],
    async acquire({ projectId, sourceId }): Promise<AcquiredContent> {
      const raw = await sources.readRawMaterial(projectId, sourceId);
      if (!raw || raw.kind !== 'text' || typeof raw.text !== 'string') {
        throw new IngestionFailure('RAW_ARTIFACT_MISSING');
      }
      return { sourceId, contentType: 'text/plain', text: raw.text, provenance: 'pasted-text' };
    },
  };
}
