/**
 * @kip
 * @module knowledge
 * @layer core
 * @owner intelligence-knowledge
 * @feature K1-005
 * @purpose Grounded answer orchestration: retrieve -> gate -> bounded evidence -> answer.
 *
 * Order matters and is deliberately enforced:
 *   1. K15 retrieval (the only source of knowledge),
 *   2. a deterministic sufficiency gate that can end the request WITHOUT prose,
 *   3. a bounded evidence pack with stable [E1..En] labels,
 *   4. one generation call through the canonical gateway,
 *   5. server-side validation of the structured output and of every citation.
 *
 * No memory, no conversation state, no chain-of-thought: one question in, one
 * evidence-grounded result out.
 */

import {
  ANSWER_ERROR_MESSAGES,
  ANSWER_EVIDENCE_LIMITS,
  KnowledgeAnswerFailure,
  assessSufficiency,
  inferLanguage,
  parseModelAnswer,
  verifyGroundedShape,
} from './knowledge-answer.ts';
import type {
  AnswerLanguage,
  EvidenceReference,
  KnowledgeAnswerInput,
  KnowledgeAnswerResult,
  RetrievalSummary,
} from './knowledge-answer.ts';
import type { RetrievalService } from '../retrieval/retrieval.service.ts';
import type { ModelGateway } from '../model-gateway/model-gateway.ts';
import type { ModelAssignmentResolver } from '../../platform/provider/model-assignment.ts';

export interface KnowledgeLabelReader {
  sources(projectId: string, sourceIds: string[]): Promise<Map<string, string>>;
  documents(projectId: string, documentIds: string[]): Promise<Map<string, string>>;
}

export interface KnowledgeAnswerObservation {
  event: 'knowledge.answer.completed' | 'knowledge.answer.failed';
  projectId: string;
  status?: string;
  confidence?: string;
  language?: string;
  questionChars: number;
  evidenceCount?: number;
  model?: string;
  retrievalMs?: number;
  answerMs?: number;
  totalMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
}

export interface KnowledgeAnswerServiceDeps {
  retrieval: RetrievalService;
  gateway: ModelGateway;
  resolver: ModelAssignmentResolver;
  labels: KnowledgeLabelReader;
  onObservation?: (observation: KnowledgeAnswerObservation) => void;
}

const trimExcerpt = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= ANSWER_EVIDENCE_LIMITS.excerptChars
    ? clean
    : `${clean.slice(0, ANSWER_EVIDENCE_LIMITS.excerptChars)}…`;
};

const STORE_MESSAGES: Record<AnswerLanguage, Record<string, string>> = {
  ar: {
    insufficient_evidence: 'المعرفة الحالية لا تكفي للإجابة بثقة.',
    conflicting_evidence: 'توجد معلومات متعارضة في المعرفة الحالية حول هذا السؤال.',
    needs_clarification: 'أحتاج توضيحًا للإجابة بدقة.',
    clarify_question: 'أي جزء من المعرفة تقصد؟',
    failed: 'تعذر توليد الإجابة.',
  },
  en: {
    insufficient_evidence: 'The current knowledge is not sufficient to answer confidently.',
    conflicting_evidence: 'The current knowledge contains conflicting information about this question.',
    needs_clarification: 'I need a clarification to answer precisely.',
    clarify_question: 'Which part of the knowledge do you mean?',
    failed: 'The answer could not be generated.',
  },
};

function buildPrompt(input: {
  question: string;
  language: AnswerLanguage;
  references: EvidenceReference[];
}): string {
  const languageName = input.language === 'ar' ? 'Arabic (Modern Standard, clear and simple)' : 'English';
  const pack = input.references
    .map((r) => `[${r.label}] ${r.logicalPath ?? r.documentTitle ?? 'document'}${r.headingContext ? ` › ${r.headingContext}` : ''}\n${trimExcerpt(r.excerpt)}`)
    .join('\n\n');
  return [
    'You are KIP, a project knowledge answering service. You answer ONLY from the evidence pack below.',
    '',
    'Rules:',
    '1. Use only the supplied evidence. Never add outside facts.',
    '2. Cite every factual claim with the evidence labels you used, e.g. [E1]. Never invent a label.',
    '3. If the evidence does not answer the question, use status "insufficient_evidence" and answer null.',
    '4. If two evidence items contradict each other on the same point, use status "conflicting_evidence" and state what conflicts.',
    '5. If the question is materially ambiguous, use status "needs_clarification" with ONE short question.',
    `6. Write the answer in ${languageName}. Be concise and professional; preserve exact identifiers and file names.`,
    '7. Do not repeat the evidence verbatim; synthesise it.',
    '8. Do not reveal your reasoning steps.',
    '',
    'Return ONLY this JSON object:',
    '{"status":"answered"|"insufficient_evidence"|"conflicting_evidence"|"needs_clarification","answer":string|null,"confidence":"high"|"medium"|"low","citations":["E1"],"message":string|null,"clarification":string|null,"choices":string[]}',
    '',
    'EVIDENCE PACK:',
    pack,
    '',
    `QUESTION: ${input.question}`,
  ].join('\n');
}

export class KnowledgeAnswerService {
  constructor(private readonly deps: KnowledgeAnswerServiceDeps) {}

  async answer(input: KnowledgeAnswerInput): Promise<KnowledgeAnswerResult> {
    const startedMs = Date.now();
    const question = (input.question ?? '').trim();
    if (question.length === 0) throw new KnowledgeAnswerFailure('ANSWER_QUESTION_EMPTY');
    if (question.length > 2000) throw new KnowledgeAnswerFailure('ANSWER_QUESTION_EMPTY', 'question too long');

    const language = inferLanguage(question, input.language);

    // 1. The answer model must be explicitly assigned — no silent fallback.
    let modelId: string;
    try {
      const resolved = await this.deps.resolver.resolve({ profile: 'knowledge_answer' });
      modelId = resolved.modelId;
    } catch {
      throw new KnowledgeAnswerFailure('ANSWER_ASSIGNMENT_MISSING');
    }

    // 2. Retrieval (the ONLY knowledge this service ever sees).
    const retrievalStart = Date.now();
    let outcome;
    try {
      outcome = await this.deps.retrieval.search({
        projectId: input.projectId,
        query: question,
        ...(input.topK !== undefined ? { topK: input.topK } : {}),
        filters: input.filters ?? {},
      });
    } catch {
      throw new KnowledgeAnswerFailure('ANSWER_RETRIEVAL_UNAVAILABLE');
    }
    const retrievalMs = Date.now() - retrievalStart;

    const summary: RetrievalSummary = {
      resultCount: outcome.results.length,
      semanticCandidates: outcome.candidates.semantic,
      lexicalCandidates: outcome.candidates.lexical,
      topSemanticScore: outcome.rawBest.semantic ?? outcome.confidence.topSemanticScore,
      topLexicalScore: outcome.rawBest.lexical ?? outcome.confidence.topLexicalScore,
      agreement: outcome.confidence.agreement,
      modelId: outcome.modelId,
    };

    // 3. Bounded evidence pack with stable labels, capped by items AND characters.
    const selected = outcome.results.slice(0, ANSWER_EVIDENCE_LIMITS.maxItems);
    const sourceIds = [...new Set(selected.map((r) => r.sourceId))];
    const documentIds = [...new Set(selected.map((r) => r.documentId))];
    const [sourceLabels, documentLabels] = await Promise.all([
      this.deps.labels.sources(input.projectId, sourceIds),
      this.deps.labels.documents(input.projectId, documentIds),
    ]);

    const references: EvidenceReference[] = [];
    let chars = 0;
    for (const [index, result] of selected.entries()) {
      const excerpt = trimExcerpt(result.text);
      if (references.length > 0 && chars + excerpt.length > ANSWER_EVIDENCE_LIMITS.maxChars) break;
      chars += excerpt.length;
      const sourceTitle = sourceLabels.get(result.sourceId);
      const documentTitle = documentLabels.get(result.documentId);
      references.push({
        label: `E${index + 1}`,
        sourceId: result.sourceId,
        documentId: result.documentId,
        chunkId: result.chunkId,
        ...(sourceTitle ? { sourceTitle } : {}),
        ...(documentTitle ? { documentTitle } : {}),
        ...(result.logicalPath ? { logicalPath: result.logicalPath } : {}),
        ...(result.headingContext ? { headingContext: result.headingContext } : {}),
        excerpt,
        fusedScore: result.score,
        ...(result.retrievalSignals.semanticScore !== undefined
          ? { semanticScore: result.retrievalSignals.semanticScore }
          : {}),
        ...(result.retrievalSignals.lexicalScore !== undefined
          ? { lexicalScore: result.retrievalSignals.lexicalScore }
          : {}),
        foundBy: result.retrievalSignals.foundBy,
      });
    }

    // 4. Sufficiency gate — decide the status BEFORE spending on prose.
    const gate = assessSufficiency(summary, references, question);
    const finish = (
      result: Omit<KnowledgeAnswerResult, 'retrievalSummary' | 'reasoningSignals' | 'evidence'> &
        Partial<Pick<KnowledgeAnswerResult, 'evidence'>>,
    ): KnowledgeAnswerResult => {
      const totalMs = Date.now() - startedMs;
      this.deps.onObservation?.({
        event: result.status === 'answered' ? 'knowledge.answer.completed' : 'knowledge.answer.completed',
        projectId: input.projectId,
        status: result.status,
        confidence: result.confidence,
        language,
        questionChars: question.length,
        evidenceCount: (result.evidence ?? references).length,
        model: modelId,
        retrievalMs,
        totalMs,
      });
      return {
        ...result,
        evidence: result.evidence ?? references,
        retrievalSummary: summary,
        reasoningSignals: gate.signals,
        timings: { retrievalMs, answerMs: result.answer ? Date.now() - startedMs - retrievalMs : 0, totalMs },
      };
    };

    if (gate.decision === 'insufficient') {
      return finish({
        status: 'insufficient_evidence',
        message: STORE_MESSAGES[language].insufficient_evidence,
        confidence: 'low',
        evidence: references,
      });
    }

    if (gate.decision === 'clarify') {
      const choices = [...new Set(references.map((r) => r.sourceTitle ?? r.logicalPath ?? '').filter(Boolean))].slice(0, 4);
      return finish({
        status: 'needs_clarification',
        message: STORE_MESSAGES[language].needs_clarification,
        clarification: {
          question: STORE_MESSAGES[language].clarify_question,
          ...(choices.length > 1 ? { choices } : {}),
        },
        confidence: 'low',
        evidence: references,
      });
    }

    // 5. One generation call, then server-side validation.
    const answerStart = Date.now();
    const prompt = buildPrompt({ question, language, references });
    const respond = async (extra = '') => {
      const out = await this.deps.gateway.generateText({
        projectId: input.projectId,
        runId: `knowledge-answer:${startedMs}`,
        capability: 'platform.knowledge-answer',
        input: { message: extra ? `${prompt}\n\n${extra}` : prompt },
        model: { profile: 'knowledge_answer' },
        modelId,
      });
      return out;
    };

    let completion;
    try {
      completion = await respond();
    } catch {
      this.deps.onObservation?.({
        event: 'knowledge.answer.failed',
        projectId: input.projectId,
        questionChars: question.length,
        language,
        model: modelId,
        retrievalMs,
        totalMs: Date.now() - startedMs,
        errorCode: 'ANSWER_PROVIDER_FAILED',
      });
      throw new KnowledgeAnswerFailure('ANSWER_PROVIDER_FAILED');
    }

    const labels = references.map((r) => r.label);
    let parsed = parseModelAnswer(completion.text ?? '', labels);
    // At most ONE repair pass (no recursive loops).
    if (!parsed.ok) {
      try {
        const retry = await respond(
          'Your previous reply was not usable. Reply with ONLY the JSON object described above, using only these labels: ' +
            labels.join(', '),
        );
        parsed = parseModelAnswer(retry.text ?? '', labels);
        if (parsed.ok) completion = retry;
      } catch {
        /* fall through to the safe failure below */
      }
    }
    if (!parsed.ok) throw new KnowledgeAnswerFailure('ANSWER_INVALID_MODEL_OUTPUT', parsed.reason);
    const shape = verifyGroundedShape(parsed.value);
    if (!shape.ok) throw new KnowledgeAnswerFailure('ANSWER_INVALID_MODEL_OUTPUT', shape.reason);

    const answerMs = Date.now() - answerStart;
    const value = parsed.value;

    if (value.status === 'answered') {
      const cited = references.filter((r) => value.citations.includes(r.label));
      return finish({
        status: 'answered',
        answer: value.answer,
        confidence: value.confidence ?? gate.confidence,
        evidence: cited.length > 0 ? cited : references.slice(0, 1),
      });
    }

    if (value.status === 'conflicting_evidence') {
      // Both sides stay visible; KIP does not silently pick a winner.
      return finish({
        status: 'conflicting_evidence',
        ...(value.answer ? { answer: value.answer } : {}),
        message: value.message ?? STORE_MESSAGES[language].conflicting_evidence,
        confidence: 'low',
        evidence: references,
      });
    }

    if (value.status === 'needs_clarification') {
      return finish({
        status: 'needs_clarification',
        message: value.message ?? STORE_MESSAGES[language].needs_clarification,
        clarification: value.clarification,
        confidence: 'low',
        evidence: references,
      });
    }

    return finish({
      status: 'insufficient_evidence',
      message: value.message ?? STORE_MESSAGES[language].insufficient_evidence,
      confidence: 'low',
      evidence: references,
    });
  }
}

export { ANSWER_ERROR_MESSAGES };
