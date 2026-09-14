/**
 * K12 checkpoint 7: failure atomicity.
 * Runs the REAL IngestionService + REAL persistence against a REAL source, but
 * with the document store failing, to prove the ingestion can never report
 * completed without canonical documents persisted.
 */
import { createClient } from '@supabase/supabase-js';
import { createIngestionPersistence, createIngestionSourceReader } from '../src/platform/provider/ingestion.storage.ts';
import { createSupabaseRawStorage } from '../src/platform/storage/raw-storage.ts';
import { SourceAcquisitionRouter } from '../src/core/ingestion/acquisition-router.ts';
import { IngestionService } from '../src/core/ingestion/ingestion.service.ts';
import { createTextAcquisitionAdapter } from '../src/platform/ingestion/text-acquisition.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';
import type { SupabaseStorageClient } from '../src/platform/storage/raw-storage.ts';

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = admin as unknown as SupabaseDatabase;
const rawStorage = createSupabaseRawStorage(admin as unknown as SupabaseStorageClient);

const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data![0];
const source = (
  await admin.from('sources').insert({ project_id: project.id, source_type: 'text', title: 'K12 Atomicity', status: 'registered', created_by_subject: 'closure' }).select('id')
).data![0];
await admin.from('raw_artifacts').insert({ project_id: project.id, source_id: source.id, kind: 'text', text_content: 'محتوى اختبار الذرّية', mime_type: 'text/plain' });

const real = createIngestionPersistence(db);
const failing = {
  ...real,
  // Simulated canonical-document persistence failure.
  saveDocuments: async () => {
    throw new Error('simulated document store failure');
  },
};

const reader = createIngestionSourceReader(db, rawStorage);
const service = new IngestionService({
  persistence: failing,
  sources: reader,
  router: new SourceAcquisitionRouter([createTextAcquisitionAdapter(reader)]),
});

const outcome = await service.ingest({ projectId: project.id, sourceId: source.id, actor: 'closure' });
const row = (await admin.from('ingestion_jobs').select('status, completed_at, failed_at, error_code').eq('id', outcome.job.id).maybeSingle()).data;
const docs = (await admin.from('documents').select('id').eq('ingestion_job_id', outcome.job.id)).data ?? [];

const results: string[] = [];
const mark = (l: string, p: boolean) => { results.push((p ? 'PASS ' : 'FAIL ') + l); return p; };

mark('CP7 ingestion is NOT marked completed', outcome.job.status !== 'completed');
mark('CP7 job is explicitly failed', row?.status === 'failed' && !!row?.failed_at && row?.completed_at === null);
mark('CP7 failure is typed (DOCUMENT_PERSISTENCE_FAILED)', row?.error_code === 'DOCUMENT_PERSISTENCE_FAILED');
mark('CP7 no partial document snapshot persisted', docs.length === 0);

// cleanup of the synthetic source
await admin.from('raw_artifacts').delete().eq('source_id', source.id);
await admin.from('ingestion_jobs').delete().eq('source_id', source.id);
await admin.from('documents').delete().eq('source_id', source.id);
await admin.from('sources').delete().eq('id', source.id);

console.log(results.join('\n'));
console.log('ALL_PASS ' + results.every((r) => r.startsWith('PASS')));
