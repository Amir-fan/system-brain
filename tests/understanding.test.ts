/**
 * K19 Understanding Foundation V1 — deterministic engine tests.
 * The service is deterministic (0 model calls). Memory integration/isolation and
 * "no silent mutation" are additionally proven live in scripts/k19-acceptance.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnderstandingService } from '../src/core/understanding/understanding.service.ts';
import type { BoundedUnderstandingContext, MemoryReference } from '../src/core/understanding/understanding.ts';

const svc = new UnderstandingService();
const ref = (over: Partial<MemoryReference> = {}): MemoryReference => ({
  id: 'm1', scope: 'user', memoryType: 'preference', memoryKey: 'preferred_time', payload: { value: '09:00' }, ...over,
});
const ctx = (arr: MemoryReference[] = []): BoundedUnderstandingContext => ({ user: arr, conversation: [], case: [] });

test('dialogue acts', async () => {
  assert.equal((await svc.evaluate({ projectId: 'p', text: 'What time is my appointment?' })).dialogueAct, 'QUESTION');
  assert.equal((await svc.evaluate({ projectId: 'p', text: 'The weather is nice.' })).dialogueAct, 'STATEMENT');
  assert.equal((await svc.evaluate({ projectId: 'p', text: 'No, I meant 10:00.' })).dialogueAct, 'CORRECTION');
  assert.equal((await svc.evaluate({ projectId: 'p', text: 'Yes, that is what I meant.' })).dialogueAct, 'CONFIRMATION');
  assert.equal((await svc.evaluate({ projectId: 'p', text: 'No, not that one.' })).dialogueAct, 'REJECTION');
  assert.equal((await svc.evaluate({ projectId: 'p', text: 'And what about tomorrow?' })).dialogueAct, 'FOLLOW_UP');
  assert.equal((await svc.evaluate({ projectId: 'p', text: 'Book the appointment.' })).dialogueAct, 'COMMAND');
});

test('A simple question -> QUESTION, CLEAR, one issue', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'What time is my appointment?' });
  assert.equal(r.status, 'CLEAR');
  assert.equal(r.dialogueAct, 'QUESTION');
  assert.equal(r.issues.length, 1);
});

test('B multi-issue -> two issues, no answer', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'What time is my appointment, and what documents do I need?' });
  assert.equal(r.issues.length, 2);
});

test('C correction + memory -> structured 09:00 -> 10:00, no silent write', async () => {
  const inputCtx = ctx([ref()]);
  const r = await svc.evaluate({ projectId: 'p', text: 'No, I meant 10:00.', context: inputCtx });
  assert.equal(r.dialogueAct, 'CORRECTION');
  assert.equal(r.corrections.length, 1);
  assert.equal(r.corrections[0].target, 'preferred_time');
  assert.equal(r.corrections[0].old, '09:00');
  assert.equal(r.corrections[0].new, '10:00');
  // No silent mutation: the provided context is untouched, corrections are returned only.
  assert.equal((inputCtx.user[0].payload as Record<string, unknown>).value, '09:00');
});

test('C2 Arabic correction phrasings carry a value (قصدي/أعني/مقصودي, optional لا)', async () => {
  // dialogueAct already recognized these; the value extractor must match it.
  for (const [text, expected] of [
    ['لا، قصدي 2026-09-10', '2026-09-10'],
    ['لا، أقصد 2026-09-10', '2026-09-10'],
    ['أعني 2026-09-10', '2026-09-10'],
    ['مقصودي 2026-09-10', '2026-09-10'],
    ['لا، قصدي 9', '9'],
  ]) {
    const r = await svc.evaluate({ projectId: 'p', text, context: ctx([]) });
    assert.equal(r.dialogueAct, 'CORRECTION', text);
    assert.equal(r.corrections.length, 1, text);
    assert.equal(r.corrections[0].new, expected, text);
  }
});

test('D confirmation -> CONFIRMATION, CLEAR', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'Yes, that is what I meant.' });
  assert.equal(r.dialogueAct, 'CONFIRMATION');
  assert.equal(r.status, 'CLEAR');
});

test('E rejection without resolvable alternative -> NEEDS_CLARIFICATION', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'No, not that one.', context: ctx([]) });
  assert.equal(r.dialogueAct, 'REJECTION');
  assert.equal(r.status, 'NEEDS_CLARIFICATION');
  assert.ok(r.clarification);
});

test('F resolvable reference -> CLEAR', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'What about that one?', context: ctx([ref({ id: 'only', memoryKey: 'appointment' })]) });
  assert.equal(r.status, 'CLEAR');
  assert.equal(r.references.resolved, true);
});

test('G deictic reference with ZERO candidates -> CLEAR, never an unanswerable question (B1.2)', async () => {
  // Corrected: this case used to pin NEEDS_CLARIFICATION, which asked the user to identify a
  // referent that does not exist in context. Nothing to disambiguate -> no question.
  const r = await svc.evaluate({ projectId: 'p', text: 'What about that one?', context: ctx([]) });
  assert.equal(r.status, 'CLEAR');
  assert.equal(r.clarification, undefined);
  assert.equal(r.references.resolved, false);
  assert.equal(r.references.referent, undefined);
  assert.equal(r.references.needsClarification, false);
  assert.equal(r.ambiguity.material, false);
});

test('H temporal normalization against explicit timestamp', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'My appointment is tomorrow at 10.', requestTimestamp: '2026-09-15T10:00:00Z' });
  const date = r.facts.find((f) => f.key === 'date');
  const time = r.facts.find((f) => f.key === 'time');
  assert.equal(date?.value, '2026-09-16');
  assert.equal(date?.original, 'tomorrow');
  assert.equal(time?.value, '10:00');
});

test('I bounded memory context is reported, never a dump', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'What time is my appointment?', context: ctx([ref(), ref({ id: 'm2', memoryKey: 'preferred_language' }), ref({ id: 'm3', memoryKey: 'theme' })]) });
  assert.equal(r.contextUsed.userCount, 3);
  assert.deepEqual(r.contextUsed.scopes, ['user']);
});

test('J project isolation at the service level (empty cross-project context)', async () => {
  const r = await svc.evaluate({ projectId: 'other', text: 'What about that one?', context: ctx([]) });
  // Nothing from project A is injected; the cross-project evaluation sees no referents.
  assert.equal(r.contextUsed.userCount, 0);
  assert.equal(r.references.resolved, false);
});

// ---------------------------------------------------------------------------
// B1.2 — lexical-safe Arabic deictic matching + no unanswerable reference question.
// `references.referent` is set only when a deictic token matched together with exactly one
// candidate, so it is the cleanest public signal that the token was (or was not) detected.
// ---------------------------------------------------------------------------

const reportedSentence = 'نزل علي دم اليوم، وأنا مو حامل ولا نفساء، واستمر 7 ساعات وبعدين وقف. هل أصلي؟';

test('K lexical-token matching: نفساء does not trigger نفس; نفس الشيء still resolves', async () => {
  const one = ctx([ref({ id: 'only', memoryKey: 'appointment' })]);
  for (const text of ['أنا مو حامل ولا نفساء', 'كذلك الأمر', 'النفس', 'نفسي أريد أن أعرف']) {
    const r = await svc.evaluate({ projectId: 'p', text, context: one });
    assert.equal(r.references.referent, undefined, `${text}: must not be read as a deictic reference`);
    assert.equal(r.status, 'CLEAR', text);
  }
  for (const text of ['نفس الشيء', 'أريد ذلك', 'هل هذا صحيح؟']) {
    const r = await svc.evaluate({ projectId: 'p', text, context: one });
    assert.equal(r.references.referent, 'appointment', `${text}: a standalone deictic token still resolves`);
  }
});

test('L the reported sentence passes the reference gate (no referent question)', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: reportedSentence, context: ctx([]) });
  assert.notEqual(r.clarification?.question, 'إلى أي عنصر تشير بالضبط؟');
  assert.equal(r.references.resolved, true);
  assert.equal(r.ambiguity.material, false);
  assert.equal(r.status, 'CLEAR');
});

test('M zero candidates: deictic detected but NO unanswerable reference question', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'نفس الشيء', context: ctx([]) });
  assert.equal(r.references.resolved, false);
  assert.equal(r.references.needsClarification, false);
  assert.equal(r.ambiguity.material, false);
  assert.equal(r.status, 'CLEAR');
  assert.equal(r.clarification, undefined);
});

test('N multiple legitimate candidates keep the clarification (real ambiguity preserved)', async () => {
  const two = ctx([ref({ id: 'a', memoryKey: 'appointment' }), ref({ id: 'b', memoryKey: 'preferred_language' })]);
  const r = await svc.evaluate({ projectId: 'p', text: 'نفس الشيء', context: two });
  assert.equal(r.references.resolved, false);
  assert.equal(r.references.needsClarification, true);
  assert.equal(r.ambiguity.material, true);
  assert.equal(r.status, 'NEEDS_CLARIFICATION');
  assert.equal(r.clarification?.reason, 'unresolved_reference');
  assert.equal(r.clarification?.question, 'إلى أي عنصر تشير بالضبط؟');
});

test('O zero-candidate rejection asks its ANSWERABLE alternative, never a referent question', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'No, not that one.', context: ctx([]) });
  assert.equal(r.dialogueAct, 'REJECTION');
  assert.equal(r.status, 'NEEDS_CLARIFICATION');
  assert.equal(r.clarification?.question, 'ما هو الخيار الذي تقصده بدلاً من ذلك؟');
  assert.notEqual(r.clarification?.question, 'إلى أي عنصر تشير بالضبط؟');
});

test('invalid input rejected', async () => {
  await assert.rejects(svc.evaluate({ projectId: 'p', text: '   ' }), /النص مطلوب/);
});
