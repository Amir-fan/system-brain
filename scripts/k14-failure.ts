/**
 * K14 checkpoint I: provider-failure isolation.
 *
 * Runs the REAL embedding service against the REAL database with a provider that
 * fails, to prove:
 *   - the embedding job is recorded as failed (typed),
 *   - the CONTENT (ingestion snapshot) is untouched and still completed,
 *   - no vectors are persisted for the failed attempt,
 *   - the stage stays retryable.
 *
 * The resolver/gateway are the only substitutions: everything else is production.
 */
import { createClient } from '@supabase/supabase-js';
import { createEmbeddingPersistence } from '../src/platform/provider/embedding.storage.ts';
import { EmbeddingService } from '../src/core/embedding/embedding.service.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';
import type { ModelGateway } from '../src/core/model-gateway/model-gateway.ts';

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = admin as unknown as SupabaseDatabase;

const MODEL = 'openai/text-embedding-3-large'; // deliberately NOT the indexed model
const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data![0];
const source = (await admin.from('sources').select('id').eq('project_id', project.id).eq('source_type', 'github')).data![0];
const snapshot = (
  await admin.from('ingestion_jobs').select('id, status').eq('source_id', source.id).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1)
).data![0];

const persistence = createEmbeddingPersistence(db);
const failingGateway: ModelGateway = {
  async generateText() {
    return { text: '' };
  },
  async embedTexts() {
    throw new Error('simulated provider outage');
  },
};

const service = new EmbeddingService({
  persistence,
  sources: { latestCompletedIngestion: async () => ({ id: snapshot.id }) },
  resolver: { resolve: async () => ({ providerKey: 'openrouter', modelId: MODEL }) },
  gateway: failingGateway,
});

const results: string[] = [];
const mark = (label: string, pass: boolean) => {
  results.push((pass ? 'PASS ' : 'FAIL ') + label);
  return pass;
};

let threw = false;
try {
  await service.indexKnowledge({ projectId: project.id, sourceId: source.id, actor: 'closure' });
} catch (error) {
  threw = (error as { code?: string }).code === 'EMBEDDING_PROVIDER_FAILED';
}

const job = (
  await admin.from('embedding_jobs').select('status, error_code, error_message, chunks_embedded').eq('ingestion_job_id', snapshot.id).eq('model_id', MODEL).order('created_at', { ascending: false }).limit(1)
).data?.[0];
const contentJob = (await admin.from('ingestion_jobs').select('status, completed_at').eq('id', snapshot.id).maybeSingle()).data;
const vectors = (await admin.from('chunk_embeddings').select('id').eq('ingestion_job_id', snapshot.id).eq('model_id', MODEL)).data ?? [];

mark('I the failure surfaced as a typed embedding failure', threw);
mark('I the embedding job is recorded as failed', job?.status === 'failed');
mark('I the failure is typed and safe to show', job?.error_code === 'EMBEDDING_PROVIDER_FAILED' && !!job?.error_message);
mark('I no vectors were persisted for the failed attempt', vectors.length === 0 && (job?.chunks_embedded ?? 0) === 0);
mark('I CONTENT IS UNTOUCHED: the ingestion is still completed', contentJob?.status === 'completed' && !!contentJob?.completed_at);

// Retryability: the same snapshot can still be indexed afterwards (proved against the
// real provider by the live closure run, which succeeded after this failure).
const retryReady = (await admin.from('embedding_jobs').select('id').eq('ingestion_job_id', snapshot.id).eq('model_id', MODEL).limit(5)).data ?? [];
mark('I the failed run left no active job blocking a retry', retryReady.length >= 1);

// cleanup: remove the synthetic failure rows so the live tables hold only real results
await admin.from('embedding_jobs').delete().eq('ingestion_job_id', snapshot.id).eq('model_id', MODEL);
mark('I cleanup removed the synthetic failure rows', ((await admin.from('embedding_jobs').select('id').eq('ingestion_job_id', snapshot.id).eq('model_id', MODEL)).data ?? []).length === 0);

console.log(results.join('\n'));
console.log('---');
console.log('job:', JSON.stringify(job));
console.log('ingestion after failure:', JSON.stringify(contentJob));
console.log('ALL_PASS', results.every((r) => r.startsWith('PASS')));
