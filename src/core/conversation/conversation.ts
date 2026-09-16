/**
 * @kip
 * @module conversation
 * @layer core
 * @owner platform-core
 * @feature K23
 * @purpose Small generic conversation/session layer: maintains coherent multi-turn
 *          sessions over the existing intelligence capabilities (K19 Understanding,
 *          K18 Memory where policy allows, K22 Decision Readiness, K20 Skills Runtime),
 *          enforcing an explicit context-access policy per session mode.
 *
 * NOT a new brain, NOT a conversation platform, NOT a second Memory. Project-agnostic:
 * no domain/fiqh concepts here.
 */

import type { SkillAnswer, SkillTraceSummary } from '../skill/skill.ts';

export type ConversationMode = 'contextual' | 'private';
export type ConversationStatus = 'active' | 'closed';
export type ConversationTurnStatus = 'completed' | 'needs_information' | 'insufficient_context' | 'needs_clarification' | 'failed';

/** Real execution stages only (truthful progress — no fake reasoning). */
export type ConversationStage =
  | 'UNDERSTANDING'
  | 'CONTEXT_RETRIEVAL'
  | 'CHECKING_READINESS'
  | 'EXECUTING_SKILL'
  | 'PREPARING_RESPONSE';

export interface SessionTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

/** Bounded session-local continuity. NEVER personal Memory; NEVER a full transcript. */
export interface SessionContext {
  facts: Record<string, unknown>;
  pendingKey?: string;
  turnCount: number;
  recentTurns: SessionTurn[];
  /** Latest grounded terminal result (bounded; cleared by a material correction). */
  lastGroundedResult?: LastGroundedResult;
}

export interface ConversationSession {
  id: string;
  projectId: string;
  actorSubject: string;
  mode: ConversationMode;
  status: ConversationStatus;
  sessionContext: SessionContext;
  createdAt: string;
  updatedAt: string;
}

export const MAX_RECENT_TURNS = 8;

export function emptySessionContext(): SessionContext {
  return { facts: {}, turnCount: 0, recentTurns: [] };
}

/** Context-access policy per mode. PRIVATE denies personal Memory read AND write. */
export interface ContextPolicy {
  mode: ConversationMode;
  /** Personal K18 memory READ allowed. */
  personalMemoryRead: boolean;
  /** Personal K18 memory WRITE allowed (never true in V1). */
  personalMemoryWrite: boolean;
  /** Non-personal PROJECT-level defaults allowed. */
  projectDefaults: boolean;
}

export function policyFor(mode: ConversationMode): ContextPolicy {
  return mode === 'private'
    ? { mode, personalMemoryRead: false, personalMemoryWrite: false, projectDefaults: true }
    : { mode, personalMemoryRead: true, personalMemoryWrite: false, projectDefaults: true };
}

export type InteractionType = 'single_choice' | 'multiple_choice' | 'yes_no' | 'number' | 'date' | 'duration' | 'free_text';

/**
 * Structured interaction contract. The internal requirement `key` stays separate from
 * the user-facing `question`. Clients (Naqaa) render `type` as buttons/picker/input.
 */
export interface InteractionSpec {
  type: InteractionType;
  key: string;
  question: string;
  options?: string[];
  allowOther?: boolean;
  required?: boolean;
}

export interface ConversationMessageInput {
  text: string;
  /** Structured answers mapping straight back to internal requirement keys. */
  answers?: Array<{ key: string; value: unknown }>;
  /** Optional explicit skill to invoke (defaults to the session's configured skill). */
  skillId?: string;
}

/**
 * The latest GROUNDED terminal result in this conversation (session-local, bounded).
 * NOT Memory, NOT conversation history, NOT a decision store: it only lets a
 * follow-up ("ليش؟" / "شنو المصدر؟") be answered from the decision that was actually
 * grounded, instead of restarting the questioning flow.
 */
export interface LastGroundedResult {
  skillId: string;
  status: string;
  decision?: string;
  explanation?: string;
  sourceTitle?: string;
  evidenceRefs: string[];
}

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
  /** Bounded, non-reasoning skill trace (admin inspection); never chain-of-thought. */
  trace?: SkillTraceSummary;
  /** Present when the executed skill produced a grounded user-facing answer. */
  answer?: SkillAnswer;
}

export type ConversationErrorCode = 'CONVERSATION_NOT_FOUND' | 'CONVERSATION_FORBIDDEN' | 'CONVERSATION_INPUT_INVALID';

export const CONVERSATION_ERROR_MESSAGES: Record<ConversationErrorCode, string> = {
  CONVERSATION_NOT_FOUND: 'المحادثة غير موجودة.',
  CONVERSATION_FORBIDDEN: 'لا يمكن الوصول إلى هذه المحادثة.',
  CONVERSATION_INPUT_INVALID: 'مدخلات المحادثة غير صالحة.',
};

export class ConversationFailure extends Error {
  readonly code: ConversationErrorCode;
  constructor(code: ConversationErrorCode, detail?: string) {
    super(CONVERSATION_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'ConversationFailure';
    if (detail) this.stack = `${this.stack ?? ''}\n[cause] ${detail}`;
  }
}
