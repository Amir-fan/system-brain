import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFiqhHaydRagSkill, FIQH_HAYD_RAG_SKILL_ID } from '../src/domain/naqaa/fiqh-hayd-rag-skill.ts';
import { APPROVED_SOURCE_TITLES } from '../src/domain/naqaa/fiqh-hayd-contracts.ts';
import type { SkillExecutionContext, SkillKnowledgePassage } from '../src/core/skill/skill.ts';

const APPROVED_SOURCE_ID = 'approved-source';
const passage = (sourceId = APPROVED_SOURCE_ID): SkillKnowledgePassage => ({
  chunkId: 'chunk-1', documentId: 'document-1', sourceId, sourceTitle: APPROVED_SOURCE_TITLES[0], chunkIndex: 0,
  text: 'أقل الطهر بين الحيضتين خمسة عشر يومًا.',
});

function context(opts: { response?: string; passages?: SkillKnowledgePassage[] } = {}) {
  const seen: { query?: string; sourceIds?: string[]; message?: string; instructions?: string } = {};
  return {
    seen,
    value: {
      projectId: 'project', actor: 'actor',
      input: {
        text: 'ما معنى الطهر بين الحيضتين؟',
        recentTurns: [{ role: 'user', text: 'عندي سؤال عن الطهر.' }],
      },
      knowledge: {
        async resolveSources() { return [{ id: APPROVED_SOURCE_ID, title: APPROVED_SOURCE_TITLES[0] }]; },
        async search(input: { query: string; sourceIds?: string[] }) {
          seen.query = input.query;
          seen.sourceIds = input.sourceIds;
          return opts.passages ?? [passage()];
        },
        async adjacent() { return []; },
      },
      model: {
        async generateText(input: { instructions?: string; message?: string }) {
          seen.instructions = input.instructions;
          seen.message = input.message;
          return { text: opts.response ?? 'هو فترة انقطاع الدم بين حيضة وأخرى.' };
        },
      },
    } as unknown as SkillExecutionContext,
  };
}

test('conversational RAG sends only approved-source evidence to one natural-language model call', async () => {
  const { value, seen } = context();
  const result = await createFiqhHaydRagSkill().execute(value) as Record<string, any>;

  assert.equal(createFiqhHaydRagSkill().id, FIQH_HAYD_RAG_SKILL_ID);
  assert.deepEqual(seen.sourceIds, [APPROVED_SOURCE_ID]);
  assert.match(seen.query ?? '', /ما معنى الطهر/);
  assert.match(seen.message ?? '', /عندي سؤال عن الطهر/);
  assert.match(seen.message ?? '', /أقل الطهر/);
  assert.match(seen.instructions ?? '', /فقط الحقائق الموجودة/);
  assert.match(seen.instructions ?? '', /المذهب الشافعي/);
  assert.equal(result.answer.text, 'هو فترة انقطاع الدم بين حيضة وأخرى.');
  assert.deepEqual(result.answer.evidenceIds, ['chunk-1']);
  assert.equal(result.trace.sourceSupport, 'SUPPORTED');
});

test('conversational RAG excludes a retrieval hit outside the approved source set', async () => {
  const { value } = context({ passages: [passage('unapproved-source')] });
  const result = await createFiqhHaydRagSkill().execute(value) as Record<string, any>;

  assert.equal(result.trace.status, 'SOURCE_GAP');
  assert.equal(result.answer.evidenceIds, undefined);
});
