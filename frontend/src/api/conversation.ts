/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @feature K24
 * @purpose Minimal frontend client for the K23 conversation API + admin test evaluation.
 * Adapts to the REAL K23 response contract; does not duplicate conversation logic.
 */

import { call, json } from './transport';

export type ConversationMode = 'contextual' | 'private';
export type ConversationTurnStatus = 'completed' | 'needs_information' | 'insufficient_context' | 'needs_clarification' | 'failed';
export type InteractionType = 'single_choice' | 'multiple_choice' | 'yes_no' | 'number' | 'date' | 'duration' | 'free_text';
export type ConversationStage = 'UNDERSTANDING' | 'CONTEXT_RETRIEVAL' | 'CHECKING_READINESS' | 'EXECUTING_SKILL' | 'PREPARING_RESPONSE';

export interface InteractionSpec {
  type: InteractionType;
  key: string;
  question: string;
  options?: string[];
  allowOther?: boolean;
  required?: boolean;
}

/**
 * Bounded, NON-reasoning trace a domain skill may attach for admin inspection
 * (issue, approved source ids, citation ids, derived requirement keys). It never
 * carries model prompts or hidden reasoning.
 */
export interface SkillTraceSummary {
  issue?: string;
  status?: string;
  approvedSourceIds?: string[];
  evidence?: Array<{ chunkId: string; sourceId: string; note?: string }>;
  requirementKeys?: string[];
  notes?: string[];
}

/** Exact shape of the real K23 ConversationService.handleMessage response. */
export interface ConversationResponse {
  conversationId: string;
  mode: ConversationMode;
  status: ConversationTurnStatus;
  understanding: { status: string; dialogueAct: string };
  readiness?: { status: string; missingKeys: string[] };
  message: string;
  interaction?: InteractionSpec;
  stages: ConversationStage[];
  runId?: string;
  trace?: SkillTraceSummary;
}

export interface SkillListItem {
  id: string;
  version: number;
  description: string;
  requirements?: { understanding?: boolean; memory?: boolean; knowledge?: boolean; model?: boolean };
}

export interface CreateConversationResult {
  id: string;
  mode: ConversationMode;
  status: string;
}

export type EvaluationCategory = 'understanding' | 'clarification' | 'context' | 'source' | 'result' | 'wording' | 'other';

export interface EvaluationInput {
  isCorrect: boolean;
  problemCategory?: EvaluationCategory;
  note?: string;
}

export interface EvaluationListItem {
  id: string;
  conversationId: string;
  isCorrect: boolean;
  problemCategory?: string | null;
  note?: string | null;
  createdAt: string;
  conversationMode?: ConversationMode | null;
  conversationStatus?: 'active' | 'closed' | null;
}

export const conversationApi = {
  createConversation: (projectId: string, mode: ConversationMode) =>
    call<CreateConversationResult>(`/v1/projects/${projectId}/conversations`, json('POST', { mode })),

  sendMessage: (projectId: string, conversationId: string, body: { text: string; answers?: Array<{ key: string; value: unknown }>; skillId?: string }) =>
    call<ConversationResponse>(`/v1/projects/${projectId}/conversations/${conversationId}/messages`, json('POST', body)),

  saveEvaluation: (projectId: string, conversationId: string, body: EvaluationInput) =>
    call<{ id: string }>(`/v1/projects/${projectId}/conversations/${conversationId}/evaluation`, json('POST', body)),

  listEvaluations: (projectId: string) =>
    call<EvaluationListItem[]>(`/v1/projects/${projectId}/conversations/evaluations`),

  /** Existing skill registry surface (used to pick which skill the test drives). */
  listSkills: (projectId: string) => call<SkillListItem[]>(`/v1/projects/${projectId}/skills`),
};