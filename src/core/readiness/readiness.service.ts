/**
 * @kip
 * @module readiness
 * @layer core
 * @owner platform-core
 * @feature K22
 * @purpose The generic Decision Readiness evaluator. Deterministic — zero model calls.
 *
 * KNOWN CONTEXT FIRST → GAP DETECTION SECOND → QUESTION THIRD.
 * Only declared MATERIAL requirements can block; non-material gaps never block.
 * Never asks about information already reliably known. Never forces READY.
 */

import {
  hasKnownValue,
  type DecisionRequirement,
  type KnownContextItem,
  type MissingMaterialInformation,
  type ReadinessResult,
} from './readiness.ts';

export interface ReadinessInput {
  requirements: DecisionRequirement[];
  known: KnownContextItem[];
  /**
   * Optional UX target: after this many answers the gate STILL never forces READY;
   * it exists only so callers can observe the target. Correctness is unaffected.
   */
  questionsAsked?: number;
  targetQuestions?: number;
}

export const DEFAULT_TARGET_QUESTIONS = 5;

export class DecisionReadinessService {
  evaluate(input: ReadinessInput): ReadinessResult {
    const known = new Map(input.known.map((k) => [k.key, k]));
    const satisfied: string[] = [];
    const missing: MissingMaterialInformation[] = [];

    for (const req of input.requirements) {
      if (!req.material) continue; // non-material gaps never block
      if (hasKnownValue(known.get(req.key))) {
        satisfied.push(req.key);
      } else {
        missing.push({
          key: req.key,
          description: req.description,
          ...(req.question ? { question: req.question } : {}),
          ...(req.interaction ? { interaction: req.interaction } : {}),
        });
      }
    }

    // Deterministic next question: first missing material requirement that is askable.
    const nextQuestion = missing.find((m) => m.question)?.question;

    let status: ReadinessResult['status'];
    if (missing.length === 0) {
      status = 'READY_FOR_DECISION';
    } else if (missing.some((m) => !m.question)) {
      // A material gap that cannot be resolved by asking (a context provider is
      // unavailable) — asking everything will not make the case ready.
      status = 'INSUFFICIENT_CONTEXT';
    } else {
      // Never force READY because a UX target was reached: still NEEDS_INFORMATION.
      status = 'NEEDS_INFORMATION';
    }

    return {
      status,
      satisfied,
      missing,
      ...(status === 'NEEDS_INFORMATION' && nextQuestion ? { nextQuestion } : {}),
      knownContextUsed: input.known.length,
    };
  }
}
