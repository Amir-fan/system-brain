/**
 * K15 retrieval benchmark (FROZEN before tuning).
 *
 * Compares VECTOR-ONLY / LEXICAL-ONLY / HYBRID-RRF on a gold set built from REAL
 * indexed knowledge (the kip-next repository + a real Arabic Wikipedia article).
 *
 * Expectations are defined from the CORPUS (which document genuinely contains the
 * answer), never from observed retrieval results. A gold-validation pass runs
 * FIRST: if an expected marker is absent from the corpus, the query is reported as
 * a bad expectation instead of silently scoring zero.
 */
import { createClient } from '@supabase/supabase-js';
import { OpenRouterGateway } from '../src/platform/model-gateway/openrouter.gateway.ts';
import { ResolvingModelGateway } from '../src/platform/model-gateway/resolving-gateway.ts';
import { createModelAssignmentResolver, createModelAssignmentStorage } from '../src/platform/provider/model-assignment.ts';
import { createProviderStorage } from '../src/platform/provider/provider.storage.ts';
import { createRetrievalStorage } from '../src/platform/provider/retrieval.storage.ts';
import { RetrievalService } from '../src/core/retrieval/retrieval.service.ts';
import { reciprocalRankFusion, diversify } from '../src/core/retrieval/retrieval.ts';
import { EMBEDDING_DIMENSIONS } from '../src/core/embedding/embedding.ts';
import type { SupabaseDatabase } from '../src/platform/supabase/supabase.persistence.ts';

const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = admin as unknown as SupabaseDatabase;
const project = (await admin.from('projects').select('id').eq('name', 'KIP Demo Project')).data![0];

const storage = createProviderStorage(db);
const secret = await storage.readSecret('openrouter');
if (!secret) throw new Error('provider credential unavailable through the canonical path');
const openRouter = new OpenRouterGateway({ apiKey: secret, defaultModel: 'openai/gpt-4o-mini' });
const resolver = createModelAssignmentResolver(createModelAssignmentStorage(db));
const gateway = new ResolvingModelGateway(openRouter, resolver);
const retrieval = createRetrievalStorage(db);
const service = new RetrievalService({ vector: retrieval, lexical: retrieval, index: retrieval, resolver, gateway });

type SourceKey = 'repo' | 'arabic';
interface Gold {
  id: string;
  category: string;
  lang: 'ar' | 'en' | 'mixed';
  query: string;
  source?: SourceKey;
  marker?: string;
}
interface Case extends Gold {
  sourceIds: string[];
  filters?: { sourceIds: string[] };
}

// ---------------------------------------------------------------- FROZEN gold set (v2)
// FROZEN BEFORE TUNING. Expectations are grounded in the ACTUAL indexed corpus:
// every marker below was verified present in the indexed chunks of its source
// (the GitHub acquisition is bounded to 40 depth-ordered files, so the repo corpus
// is a subset, and path-lookup queries are matched against logical_path).
export const GOLD: Case[] = [
  // 1. semantic paraphrase (EN)
  { id: 'q01', category: 'semantic', lang: 'en', query: 'rules the team must follow when engineering the platform', source: 'repo', marker: 'KIP_ENGINEERING_CONSTITUTION' },
  // 2. exact terminology (EN)
  { id: 'q02', category: 'terminology', lang: 'en', query: 'ADR-001', source: 'repo', marker: 'ADR-001' },
  // 3. filename / path lookup
  { id: 'q03', category: 'path', lang: 'en', query: 'boot.ts', source: 'repo', marker: 'boot.ts' },
  // 4. path lookup (documentation)
  { id: 'q04', category: 'path', lang: 'en', query: 'NAMING_REGISTRY.md', source: 'repo', marker: 'NAMING_REGISTRY' },
  // 5. code / API concept (EN)
  { id: 'q05', category: 'code', lang: 'en', query: 'where the application starts and wires its dependencies', source: 'repo', marker: 'boot.ts' },
  // 6. ambiguous (EN)
  { id: 'q06', category: 'ambiguous', lang: 'en', query: 'documents', source: 'repo', marker: 'المستندات' },
  // 7. answer NOT present in the corpus
  { id: 'q07', category: 'not-present', lang: 'en', query: 'what is the capital city of Mongolia' },
  // 8. Arabic wording variation
  { id: 'q08', category: 'arabic-variation', lang: 'ar', query: 'ما هو التعلم العميق', source: 'arabic', marker: 'العميق' },
  // 9. English wording variation (against Arabic knowledge)
  { id: 'q09', category: 'english-variation', lang: 'en', query: 'neural networks and machine learning', source: 'arabic', marker: 'العصبية' },
  // 10. multi-concept (mixed)
  { id: 'q10', category: 'multi-concept', lang: 'mixed', query: 'الشبكات العصبية الاصطناعية وتعلم الآلة', source: 'arabic', marker: 'الشبكات' },
  // 11. Arabic exact terminology
  { id: 'q11', category: 'arabic-terminology', lang: 'ar', query: 'الذكاء الاصطناعي', source: 'arabic', marker: 'الاصطناعي' },
  // 12. Arabic semantic
  { id: 'q12', category: 'arabic-semantic', lang: 'ar', query: 'كيف يتعلم الحاسوب من البيانات', source: 'arabic', marker: 'البيانات' },
  // 13. Arabic semantic (medicine)
  { id: 'q13', category: 'arabic-semantic', lang: 'ar', query: 'استخدام الذكاء الاصطناعي في الطب والتشخيص', source: 'arabic', marker: 'الطب' },
  // 14. Arabic semantic (translation)
  { id: 'q14', category: 'arabic-semantic', lang: 'ar', query: 'الترجمة الآلية بين اللغات', source: 'arabic', marker: 'الترجمة' },
  // 15. Arabic semantic (robotics)
  { id: 'q15', category: 'arabic-semantic', lang: 'ar', query: 'الروبوتات والذكاء الاصطناعي', source: 'arabic', marker: 'الروبوت' },
  // 16. Arabic semantic (algorithms)
  { id: 'q16', category: 'arabic-semantic', lang: 'ar', query: 'الخوارزميات المستخدمة في الذكاء الاصطناعي', source: 'arabic', marker: 'الخوارزميات' },
  // 17. mixed Arabic/English (repo, Arabic UI strings)
  { id: 'q17', category: 'mixed', lang: 'mixed', query: 'KIP معالجة المستندات documents processing', source: 'repo', marker: 'معالجة' },
  // 18. mixed Arabic/English (sources registry)
  { id: 'q18', category: 'mixed', lang: 'mixed', query: 'سجل المصادر sources registry', source: 'repo', marker: 'المصادر' },
  // 19. English semantic (architecture decisions)
  { id: 'q19', category: 'semantic', lang: 'en', query: 'architecture decision records for the project', source: 'repo', marker: 'ADR-001' },
  // 20. English semantic (Arabic knowledge, AI)
  { id: 'q20', category: 'semantic', lang: 'en', query: 'what is artificial intelligence', source: 'arabic', marker: 'الاصطناعي' },
  // 21. English semantic (learning from data)
  { id: 'q21', category: 'semantic', lang: 'en', query: 'how machines learn from data', source: 'arabic', marker: 'تعلم' },
  // 22. Arabic semantic (engineering rules, repo)
  { id: 'q22', category: 'arabic-semantic', lang: 'ar', query: 'قواعد الهندسة البرمجية للمشروع', source: 'repo', marker: 'KIP_ENGINEERING_CONSTITUTION' },
];

const sources = (await admin.from('sources').select('id, external_uri').eq('project_id', project.id)).data!;
const repoSource = sources.find((s) => (s.external_uri ?? '').includes('github'))!;
const arabicSource = sources.find((s) => (s.external_uri ?? '').includes('wikipedia'))!;
console.log('sources: repo =', repoSource.id, '| arabic =', arabicSource.id);

// ---------------------------------------------------------------- gold validation (before measuring)
const validated: Array<Case | null> = [];
for (const gold of GOLD) {
  if (!gold.source || !gold.marker) {
    validated.push({ ...gold });
    continue;
  }
  const sourceId = gold.source === 'repo' ? repoSource.id : arabicSource.id;
  const { data } = (await db
    .from('document_chunks')
    .select('id')
    .eq('project_id', project.id)
    .eq('source_id', sourceId)
    .ilike('text_content', `%${gold.marker}%`)
    .limit(1)) as unknown as { data: Array<{ id: string }> | null };
  if (!data || data.length === 0) {
    console.log(`GOLD INVALID ${gold.id}: marker "${gold.marker}" absent from source ${gold.source}`);
    validated.push(null);
    continue;
  }
  validated.push({ ...gold, sourceIds: [sourceId] });
}
const cases = validated.filter((c): c is Case => c !== null);
console.log(`gold validated: ${cases.length}/${GOLD.length}`);

// ---------------------------------------------------------------- strategies
const norm = (t: string) => t.toLowerCase();
const hit = (row: { text: string; sourceId: string; logicalPath?: string }, gold: Case) => {
  if (!gold.sourceIds || !gold.marker) return false;
  if (row.sourceId !== gold.sourceIds[0]) return false;
  const needle = norm(gold.marker);
  return norm(row.text).includes(needle) || norm(row.logicalPath ?? '').includes(needle);
};

async function queryVector(query: string): Promise<number[]> {
  const out = await gateway.embedTexts({
    projectId: project.id,
    runId: 'bench',
    texts: [query],
    inputType: 'query',
    dimensions: EMBEDDING_DIMENSIONS,
  });
  const v = out.vectors[0];
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS) throw new Error('bad query vector');
  return v;
}

const hotPresentScores: number[] = [];
const presentSemanticTop: number[] = [];
const presentLexicalTop: number[] = [];
const metrics = {
  vector: { r5: 0, r8: 0, mrr: 0, n: 0 },
  lexical: { r5: 0, r8: 0, mrr: 0, n: 0 },
  hybrid: { r5: 0, r8: 0, mrr: 0, n: 0 },
  'hybrid-weighted': { r5: 0, r8: 0, mrr: 0, n: 0 },
};
const timings = { embed: [] as number[], vector: [] as number[], lexical: [] as number[], fusion: [] as number[], total: [] as number[] };
const notPresentObservations: Array<{ id: string; topFused: number; topSemantic: number | null; topLexical: number | null; agreement: number }> = [];

for (const gold of cases) {
  if (gold.category === 'not-present') {
    const outcome = await service.search({ projectId: project.id, query: gold.query, topK: 8 });
    notPresentObservations.push({
      id: gold.id,
      topFused: outcome.confidence.topFusedScore,
      topSemantic: outcome.confidence.topSemanticScore,
      topLexical: outcome.confidence.topLexicalScore,
      agreement: outcome.confidence.agreement,
    });
    console.log(`[${gold.id}] not-present query -> results=${outcome.results.length} topFused=${outcome.confidence.topFusedScore.toFixed(4)} topSemantic=${outcome.confidence.topSemanticScore?.toFixed(4) ?? 'null'} topLexical=${outcome.confidence.topLexicalScore?.toFixed(4) ?? 'null'}`);
    continue;
  }

  const t0 = Date.now();
  const qv = await queryVector(gold.query);
  timings.embed.push(Date.now() - t0);

  const t1 = Date.now();
  const vecRows = await retrieval.vectorSearch({ projectId: project.id, modelId: 'google/gemini-embedding-001', queryVector: qv, limit: 30, filters: {} });
  timings.vector.push(Date.now() - t1);

  const t2 = Date.now();
  const lexRows = await retrieval.lexicalSearch({ projectId: project.id, query: gold.query, limit: 30, filters: {} });
  timings.lexical.push(Date.now() - t2);

  const t3 = Date.now();
  const weightedCandidates = diversify(reciprocalRankFusion([
    { name: 'semantic', items: vecRows, weight: 1 },
    { name: 'lexical', items: lexRows, weight: 0.5 },
  ]), 8);
  const fusedCandidates = diversify(reciprocalRankFusion([
    { name: 'semantic', items: vecRows },
    { name: 'lexical', items: lexRows },
  ]), 8);
  const fused = fusedCandidates.map((s) => s.candidate.chunk);
  hotPresentScores.push(fusedCandidates[0]?.candidate.fusedScore ?? 0);
  const bestSemantic = vecRows.find((r) => hit(r, gold));
  const bestLexical = lexRows.find((r) => hit(r, gold));
  presentSemanticTop.push(vecRows[0]?.score ?? 0);
  presentLexicalTop.push(lexRows[0]?.score ?? 0);
  void bestSemantic; void bestLexical;
  timings.fusion.push(Date.now() - t3);

  const rankOf = (rows: Array<{ text: string; sourceId: string }>) => {
    const i = rows.findIndex((r) => hit(r, gold));
    return i < 0 ? 0 : i + 1;
  };
  const vr = rankOf(vecRows);
  const lr = rankOf(lexRows);
  const hr = rankOf(fused);
  const wr = rankOf(weightedCandidates.map((s2) => s2.candidate.chunk));

  for (const [key, rank] of [['vector', vr], ['lexical', lr], ['hybrid', hr], ['hybrid-weighted', wr]] as const) {
    const m = metrics[key];
    m.n++;
    if (rank > 0 && rank <= 5) m.r5++;
    if (rank > 0 && rank <= 8) m.r8++;
    if (rank > 0) m.mrr += 1 / rank;
  }
  console.log(`[${gold.id}] ${gold.category.padEnd(19)} vector=${vr || '-'} lexical=${lr || '-'} hybrid=${hr || '-'} weighted=${wr || '-'} | cand v=${vecRows.length} l=${lexRows.length}`);
}

const pct = (x: number, n: number) => (n === 0 ? 0 : Math.round((x / n) * 1000) / 10);
const avg = (xs: number[]) => (xs.length === 0 ? 0 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
const out = [];
for (const [key, m] of Object.entries(metrics)) {
  out.push(`${key.toUpperCase().padEnd(8)} Recall@5=${pct(m.r5, m.n)}% Recall@8=${pct(m.r8, m.n)}% MRR=${(m.mrr / m.n).toFixed(3)} (n=${m.n})`);
}
console.log('---');
console.log(out.join('\n'));
console.log('---');
console.log('latency ms (avg): embed=' + avg(timings.embed) + ' vector=' + avg(timings.vector) + ' lexical=' + avg(timings.lexical) + ' fusion=' + avg(timings.fusion));
console.log('not-present observations: ' + JSON.stringify(notPresentObservations));
const presentTop = cases
  .filter((c) => c.category !== 'not-present')
  .map((c) => c.id);
console.log('gold size (present-answer cases) = ' + presentTop.length + ' | not-present cases = ' + notPresentObservations.length);
const hp = hotPresentScores;
console.log('hybrid topFused on ANSWERABLE queries: min=' + Math.min(...hp).toFixed(4) + ' median=' + hp.slice().sort((a, b) => a - b)[Math.floor(hp.length / 2)].toFixed(4) + ' max=' + Math.max(...hp).toFixed(4));
console.log('hybrid topFused on NOT-PRESENT query: ' + (notPresentObservations[0]?.topFused ?? 0).toFixed(4));
const dist = (xs: number[]) => {
  const s2 = xs.slice().sort((a, b) => a - b);
  return 'min=' + (s2[0] ?? 0).toFixed(4) + ' p25=' + (s2[Math.floor(s2.length * 0.25)] ?? 0).toFixed(4) + ' median=' + (s2[Math.floor(s2.length / 2)] ?? 0).toFixed(4) + ' max=' + (s2[s2.length - 1] ?? 0).toFixed(4);
};
console.log('TOP-VECTOR-SCORE, answerable queries: ' + dist(presentSemanticTop));
console.log('TOP-VECTOR-SCORE, not-present query: ' + (notPresentObservations[0]?.topSemantic ?? 0).toFixed(4));
console.log('TOP-LEXICAL-SCORE, answerable queries: ' + dist(presentLexicalTop.filter((x) => x > 0)));
