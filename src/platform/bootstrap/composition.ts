/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K0-003
 * @purpose Minimal composition root wiring persistence, runtime, capabilities, gateway, admin API.
 *
 * Single place config/env concerns live. No DI framework, no service container,
 * no config subsystem. KIP_PLATFORM_ADMIN_TOKEN is a TEMPORARY bootstrap admin
 * credential (env-only, non-final admin auth) — replace before production.
 *
 * The OpenRouter provider credential is NOT read from env for normal runtime.
 * It is managed via the Admin Provider API and stored in Supabase Vault; on boot
 * the Model Gateway resolves and loads it from provider_configs + Vault.
 * Model Assignment is a control-plane concern: capabilities declare a workload and
 * the ResolvingModelGateway maps it to a model through ModelAssignmentResolver.
 */

import { createClient } from '@supabase/supabase-js';
import type { Server } from 'node:http';
import { createHttpApi } from '../api/http-server.ts';
import { SupabaseActorAuthenticator } from '../api/supabase-authenticator.ts';
import { StaticTokenAuthenticator } from '../api/static-authenticator.ts';
import { CompositeActorAuthenticator } from '../api/composite-authenticator.ts';
import type { TokenActorMap } from '../api/auth.ts';
import { createProjectDiscoveryStorage } from '../api/project-discovery.ts';
import { createProviderStorage } from '../provider/provider.storage.ts';
import { createSourceStorage } from '../provider/source.storage.ts';
import { createRawArtifactStorage } from '../provider/raw-artifact.storage.ts';
import { createExternalConnectionStorage } from '../provider/external-connection.storage.ts';
import { createSupabaseRawStorage } from '../storage/raw-storage.ts';
import type { SupabaseStorageClient } from '../storage/raw-storage.ts';
import { createIngestionPersistence, createIngestionSourceReader } from '../provider/ingestion.storage.ts';
import { createEmbeddingPersistence } from '../provider/embedding.storage.ts';
import { createRetrievalStorage } from '../provider/retrieval.storage.ts';
import { createMemoryStorage } from '../provider/memory.storage.ts';
import { MemoryService } from '../../core/memory/memory.service.ts';
import type { MemoryRecord } from '../../core/memory/memory.ts';
import type { MemoryReference } from '../../core/understanding/understanding.ts';
import { UnderstandingService } from '../../core/understanding/understanding.service.ts';
import { MapSkillRegistry } from '../../core/skill/skill-registry.ts';
import { SkillsRuntime } from '../../core/skill/skill-runtime.ts';
import { demoContextSummary } from '../../core/skill/demo-context-summary.ts';
import { decisionReadinessFixture } from '../../core/skill/decision-readiness-fixture.ts';
import { conversationEligibilityFixture } from '../../core/skill/conversation-eligibility-fixture.ts';
import { DecisionReadinessService } from '../../core/readiness/readiness.service.ts';
import { ConversationService } from '../../core/conversation/conversation.service.ts';
import { createConversationStorage } from '../provider/conversation.storage.ts';
import { createEvaluationStorage } from '../provider/evaluation.storage.ts';
import { createKnowledgeEvidence } from '../provider/knowledge-evidence.ts';
import { naqaaScanner } from '../../domain/naqaa/scanner-skill.ts';
import { createFiqhHaydSkill } from '../../domain/naqaa/fiqh-hayd-skill.ts';
// EXPERIMENT (K26-mind-v0): a second, independent Naqaa skill registered alongside the
// control skill. Additive only — it is selected explicitly by skillId, never by default.
import { createFiqhHaydMindSkill } from '../../domain/naqaa/fiqh-hayd-mind-skill.ts';
import { createFiqhHaydMinimalSkill } from '../../domain/naqaa/fiqh-hayd-minimal-skill.ts';
import { RetrievalService } from '../../core/retrieval/retrieval.service.ts';
import { KnowledgeAnswerService } from '../../core/knowledge/knowledge-answer.service.ts';
import { EmbeddingService } from '../../core/embedding/embedding.service.ts';
import { createTextAcquisitionAdapter } from '../ingestion/text-acquisition.ts';
import { createUrlAcquisitionAdapter } from '../ingestion/url-acquisition.ts';
import { createGitHubAcquisitionAdapter } from '../ingestion/github-acquisition.ts';
import { createFileAcquisitionAdapter } from '../ingestion/file-acquisition.ts';
import { SourceAcquisitionRouter } from '../../core/ingestion/acquisition-router.ts';
import { IngestionService } from '../../core/ingestion/ingestion.service.ts';
import type { GitHubAppConfig } from '../github/github-app.ts';
import { createGitHubAppAuth } from '../github/github-app.ts';
import {
  createModelAssignmentStorage,
  createModelAssignmentResolver,
} from '../provider/model-assignment.ts';
import { OpenRouterGateway } from '../model-gateway/openrouter.gateway.ts';
import { ResolvingModelGateway } from '../model-gateway/resolving-gateway.ts';
import { createSupabaseRuntimePersistence } from '../supabase/supabase.persistence.ts';
import type { SupabaseDatabase } from '../supabase/supabase.persistence.ts';
import { RuntimeService } from '../../core/runtime/runtime.service.ts';
import { MapCapabilityRegistry } from '../../core/capability/capability-registry.ts';
import { platformAiCompletion } from '../../core/capability/ai-echo.ts';

export interface BootstrapEnv {
  supabaseUrl: string;
  supabaseSecretKey: string;
  openRouterModel?: string;
  /** DEV/TEST-COMPAT static tokens (legacy KIP_API_TOKENS); optional. */
  tokenActors?: TokenActorMap;
  /** Stage 3 cutover — trusted server-to-server proxy credential (KIP_PROXY_TOKENS). Optional. */
  proxyTokens?: TokenActorMap;
  /** GitHub App credentials (null/undefined when the connector is not configured). */
  githubApp?: GitHubAppConfig | null;
  /** Browser origin the provider redirects back to (never hardcoded in domain logic). */
  frontendUrl?: string;
}

export async function compose(opts: BootstrapEnv): Promise<Server> {
  const rawClient = createClient(opts.supabaseUrl, opts.supabaseSecretKey);
  const db = rawClient as unknown as SupabaseDatabase;
  const persistence = createSupabaseRuntimePersistence(db);
  const providerStorage = createProviderStorage(db);
  const sourceStorage = createSourceStorage(db);
  const artifactStorage = createRawArtifactStorage(db);
  const connectionStorage = createExternalConnectionStorage(db);
  // Private raw-file storage (server credential only; browser never sees it).
  const rawStorage = createSupabaseRawStorage(rawClient as unknown as SupabaseStorageClient);
  const assignmentStorage = createModelAssignmentStorage(db);
  const assignmentResolver = createModelAssignmentResolver(assignmentStorage);
  const projectDiscovery = createProjectDiscoveryStorage(db);

  // Identity source: Supabase Auth (production); static tokens only as dev/test-compat.
  // Stage 3: when a trusted server-to-server proxy credential is configured, compose
  // Supabase + the proxy credential into ONE authenticator (Supabase first, proxy second).
  const authenticator =
    opts.tokenActors && opts.tokenActors.size > 0
      ? new StaticTokenAuthenticator(opts.tokenActors)
      : opts.proxyTokens && opts.proxyTokens.size > 0
        ? new CompositeActorAuthenticator({ auth: rawClient.auth }, opts.proxyTokens)
        : new SupabaseActorAuthenticator({ auth: rawClient.auth });

  const registry = new MapCapabilityRegistry();
  registry.register('platform.echo', async ({ input }) => input);

  // OpenRouter is the single active provider (credential resolved from Vault).
  const openRouter = new OpenRouterGateway({
    apiKey: '',
    defaultModel: opts.openRouterModel ?? 'openrouter/auto',
  });
  const storedKey = await providerStorage.readSecret('openrouter');
  if (storedKey) openRouter.setApiKey(storedKey);

  // Control-plane gateway: resolves workload -> assigned model before the adapter.
  const gateway = new ResolvingModelGateway(openRouter, assignmentResolver);
  registry.register('platform.ai-completion', platformAiCompletion(gateway));
  registry.register('platform.ai-echo', platformAiCompletion(gateway));

  // GitHub App connector: only wired when credentials exist. Installation
  // tokens are minted on demand; the client secret doubles as the state-signing
  // secret so no additional secret has to be introduced.
  const githubDeps = opts.githubApp
    ? {
        app: createGitHubAppAuth(opts.githubApp),
        stateSecret: opts.githubApp.clientSecret,
        connections: connectionStorage,
        boundary: persistence,
        frontendUrl: opts.frontendUrl ?? 'http://localhost:5173',
      }
    : undefined;

  // Ingestion: one router, one adapter per supported source type. Content-free
  // structured observability only (project/source/job/result/duration).
  const ingestionReader = createIngestionSourceReader(db, rawStorage);
  const ingestionRouter = new SourceAcquisitionRouter([
    createTextAcquisitionAdapter(ingestionReader),
    createFileAcquisitionAdapter(ingestionReader),
    createUrlAcquisitionAdapter({ sources: ingestionReader }),
    // GitHub acquisition needs the App credentials; without them the type stays
    // unsupported rather than silently failing at request time.
    ...(githubDeps ? [createGitHubAcquisitionAdapter({ sources: ingestionReader, connections: connectionStorage, app: githubDeps.app })] : []),
  ]);
  const ingestionPersistence = createIngestionPersistence(db);

  // K14: INDEX_READY is a separate, explicit stage over a COMPLETED ingestion snapshot.

  // K15: retrieval is a platform service — two concurrent candidate retrievers,
  // rank-based fusion, deterministic diversity. It never generates answers.

  // K16: answers are built ONLY from retrieval evidence; the model never sees the corpus.
  const knowledgeLabels = {
    sources: async (projectId: string, sourceIds: string[]) => {
      const { data } = (await db
        .from('sources')
        .select('id, title')
        .eq('project_id', projectId)
        .in('id', sourceIds)) as unknown as { data: Array<Record<string, unknown>> | null };
      return new Map((data ?? []).map((r) => [r.id as string, r.title as string]));
    },
    documents: async (projectId: string, documentIds: string[]) => {
      const { data } = (await db
        .from('documents')
        .select('id, title, logical_path')
        .eq('project_id', projectId)
        .in('id', documentIds)) as unknown as { data: Array<Record<string, unknown>> | null };
      return new Map(
        (data ?? []).map((r) => [
          r.id as string,
          (r.title as string) ?? (r.logical_path as string) ?? '',
        ]),
      );
    },
  };
  const retrievalStorage = createRetrievalStorage(db);
  const retrievalService = new RetrievalService({
    vector: retrievalStorage,
    lexical: retrievalStorage,
    index: retrievalStorage,
    resolver: assignmentResolver,
    gateway,
    resolveSourceIdsByRole: async (projectId: string, roles: string[]) =>
      (await sourceStorage.listByProject(projectId))
        .filter((src) => roles.includes(src.role))
        .map((src) => src.id),
  });
  const embeddingPersistence = createEmbeddingPersistence(db);
  const memoryService = new MemoryService(createMemoryStorage(db));
  const toRef = (r: MemoryRecord): MemoryReference => ({ id: r.id, scope: r.scope, memoryType: r.memoryType, memoryKey: r.memoryKey, payload: r.payload });
  const memoryFetcher = async (projectId: string, ids: { subjectId?: string; conversationId?: string; caseId?: string }) => ({
    user: ids.subjectId ? (await memoryService.retrieveRelevant({ projectId, scope: 'user', subjectId: ids.subjectId, limit: 5 })).map(toRef) : [],
    conversation: ids.conversationId ? (await memoryService.retrieveRelevant({ projectId, scope: 'conversation', subjectId: ids.conversationId, limit: 5 })).map(toRef) : [],
    case: ids.caseId ? (await memoryService.retrieveRelevant({ projectId, scope: 'case', subjectId: ids.caseId, limit: 5 })).map(toRef) : [],
  });
  const understandingService = new UnderstandingService();
  const skillRegistry = new MapSkillRegistry();
  skillRegistry.register(demoContextSummary);
  skillRegistry.register(naqaaScanner);
  skillRegistry.register(decisionReadinessFixture);
  skillRegistry.register(conversationEligibilityFixture);
  const readinessService = new DecisionReadinessService();
  // K25 slice 1: the Shafi'i fiqh skill reasons over APPROVED source knowledge and
  // declares its material requirements dynamically (validated against citations).
  skillRegistry.register(createFiqhHaydSkill({ readiness: readinessService }));
  // Mind Skill V0 (experiment) — coexists with the control skill; not the default.
  skillRegistry.register(createFiqhHaydMindSkill({ readiness: readinessService }));
  // Minimal Mind V0 (experiment) — one LLM + an approved-Knowledge tool; not the default.
  skillRegistry.register(createFiqhHaydMinimalSkill({ readiness: readinessService }));
  const skillsRuntime = new SkillsRuntime({
    persistence,
    registry: skillRegistry,
    understanding: understandingService,
    memory: { fetchBounded: memoryFetcher },
    modelGateway: gateway,
    readiness: readinessService,
    // Project-scoped knowledge capability (existing K15 retriever + existing chunk
    // store for bounded adjacency). No second engine, no new table.
    knowledge: (projectId: string) =>
      createKnowledgeEvidence({ projectId, retrieval: retrievalService, sources: sourceStorage, chunks: ingestionPersistence }),
  });
  const conversationService = new ConversationService({
    persistence: createConversationStorage(db),
    understanding: understandingService,
    skills: { execute: (input) => skillsRuntime.execute(input) },
    memory: {
      fetchBounded: async (projectId: string, ids: { subjectId?: string }) => ({
        user: ids.subjectId ? (await memoryService.retrieveRelevant({ projectId, scope: 'user', subjectId: ids.subjectId, limit: 5 })).map(toRef) : [],
        conversation: [],
        case: [],
      }),
    },
    defaultSkillId: 'demo.conversation-eligibility',
    interactionsFor: (skillId: string) => {
      const skill = skillRegistry.get(skillId);
      const map: Record<string, { type: never; options?: string[]; allowOther?: boolean }> = {};
      for (const r of skill?.readiness?.requirements ?? []) {
        if (r.interaction) {
          map[r.key] = { type: r.interaction.type as never, ...(r.interaction.options ? { options: r.interaction.options } : {}), ...(r.interaction.allowOther !== undefined ? { allowOther: r.interaction.allowOther } : {}) };
        }
      }
      return map;
    },
  });
  const embeddingService = new EmbeddingService({
    persistence: embeddingPersistence,
    sources: {
      latestCompletedIngestion: async (projectId: string, sourceId: string) => {
        const job = await ingestionPersistence.latestCompletedJob(projectId, sourceId);
        return job ? { id: job.id } : null;
      },
    },
    resolver: assignmentResolver,
    gateway,
  });

  const ingestionService = new IngestionService({
    persistence: ingestionPersistence,
    sources: ingestionReader,
    router: ingestionRouter,
    observer: (event) => console.log('[ingestion]', JSON.stringify(event)),
  });

  const runtime = new RuntimeService(persistence, registry);
  return createHttpApi({
    runtime,
    authenticator,
    projects: projectDiscovery,
    sources: {
      storage: sourceStorage,
      boundary: persistence,
      artifacts: artifactStorage,
      references: connectionStorage,
      rawStorage,
    },
    connections: {
      connections: connectionStorage,
      storage: sourceStorage,
      boundary: persistence,
    },
    github: githubDeps,
    ingestion: { service: ingestionService, boundary: persistence },
    documents: { persistence: ingestionPersistence, boundary: persistence },
    chunks: { persistence: ingestionPersistence, boundary: persistence },
    knowledgeAnswer: {
      service: new KnowledgeAnswerService({
        retrieval: retrievalService,
        gateway,
        resolver: assignmentResolver,
        labels: knowledgeLabels,
      }),
      boundary: persistence,
    },
    memory: { service: memoryService, boundary: persistence },
    understanding: {
      service: understandingService,
      contextFetcher: memoryFetcher,
      boundary: persistence,
    },
    skills: {
      runtime: skillsRuntime,
      registry: skillRegistry,
      boundary: persistence,
    },
    conversation: {
      service: conversationService,
      boundary: persistence,
      evaluation: { storage: createEvaluationStorage(db), boundary: persistence },
    },
    retrieval: {
      service: retrievalService,
      rolesAvailable: async (projectId: string) =>
        [...new Set((await sourceStorage.listByProject(projectId)).map((src) => src.role))],
      labels: {
        sources: async (projectId: string, sourceIds: string[]) => {
          const { data } = (await db
            .from('sources')
            .select('id, title')
            .eq('project_id', projectId)
            .in('id', sourceIds)) as unknown as { data: Array<Record<string, unknown>> | null };
          return new Map((data ?? []).map((r) => [r.id as string, r.title as string]));
        },
        documents: async (projectId: string, documentIds: string[]) => {
          const { data } = (await db
            .from('documents')
            .select('id, title, logical_path')
            .eq('project_id', projectId)
            .in('id', documentIds)) as unknown as { data: Array<Record<string, unknown>> | null };
          return new Map(
            (data ?? []).map((r) => [
              r.id as string,
              (r.title as string) ?? (r.logical_path as string) ?? '',
            ]),
          );
        },
      },
      boundary: persistence,
    },
    embeddings: {
      service: embeddingService,
      persistence: embeddingPersistence,
      ingestion: {
        latestCompletedIngestion: async (projectId: string, sourceId: string) => {
          const job = await ingestionPersistence.latestCompletedJob(projectId, sourceId);
          return job ? { id: job.id } : null;
        },
      },
      resolver: assignmentResolver,
      sources: {
        exists: async (projectId: string, sourceId: string) =>
          Boolean(await ingestionReader.getSource(projectId, sourceId)),
      },
      boundary: persistence,
    },
    admin: {
      storage: providerStorage,
      adminApi: {
        storage: providerStorage,
        assignmentStorage,
        resolver: assignmentResolver,
        openRouter,
      },
      // Browser Admin UI logs in via Supabase Auth and sends the Supabase access token
      // here. The server verifies the token and checks the email against
      // KIP_PLATFORM_ADMIN_EMAILS before granting admin privileges.
      supabase: { auth: rawClient.auth },
    },
  });
}