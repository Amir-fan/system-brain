/**
 * @kip
 * @module ingestion
 * @layer core
 * @owner intelligence-ingestion
 * @feature K0-011
 * @purpose Routes a source type to its acquisition adapter.
 *
 * One adapter per source type; adding a source type means adding an adapter, not
 * editing the service. K10 ships text + file adapters; URL and GitHub content
 * acquisition are later slices, so those types report UNSUPPORTED_SOURCE_TYPE
 * rather than pretending to work.
 */

import { IngestionFailure } from './ingestion.types.ts';
import type { AcquiredContent } from './ingestion.types.ts';
import type { SourceAcquisitionAdapter } from './ingestion.ports.ts';
import type { SourceType } from '../project/source-type.ts';

export class SourceAcquisitionRouter {
  private readonly byType = new Map<SourceType, SourceAcquisitionAdapter>();
  private readonly registered: SourceType[] = [];

  constructor(adapters: readonly SourceAcquisitionAdapter[]) {
    for (const adapter of adapters) {
      for (const type of adapter.sourceTypes) {
        this.byType.set(type, adapter);
        this.registered.push(type);
      }
    }
  }

  supports(sourceType: SourceType): boolean {
    return this.byType.has(sourceType);
  }

  supportedTypes(): SourceType[] {
    return [...this.registered];
  }

  async acquire(input: { projectId: string; sourceId: string; sourceType: SourceType }): Promise<AcquiredContent> {
    const adapter = this.byType.get(input.sourceType);
    if (!adapter) throw new IngestionFailure('UNSUPPORTED_SOURCE_TYPE');
    return adapter.acquire(input);
  }
}
