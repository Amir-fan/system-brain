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

for (const [text, expected] of [
  ['كَمْ يوماً أحتاج', 'QUESTION'],
  ['ما معنى الطهر', 'QUESTION'],
  ['السلام عليكم، كم يوم أحتاج بعد 6 أيام', 'QUESTION'],
  ['أحتاج أنتظر ٦ أيام؟ 🙏', 'QUESTION'],
  ['‘What does purity mean?’', 'QUESTION'],
  ['ما أدري بالضبط', 'STATEMENT'],
  ['ما نزل دم', 'STATEMENT'],
  ['ما نزل دم لمدة ٦ أيام', 'STATEMENT'],
  ['كمال حضر', 'STATEMENT'],
  ['من ٦ أيام', 'STATEMENT'],
] as const) {
  test(`pending-answer Arabic dialogue act: ${text}`, async () => {
    const r = await svc.evaluate({ projectId: 'p', text });
    assert.equal(r.dialogueAct, expected);
  });
}

test('a question-shaped correction produces no replacement for a known fact', async () => {
  const r = await svc.evaluate({
    projectId: 'p', text: 'لا، قصدي 6؟',
    context: ctx([ref({ memoryKey: 'count', payload: { value: 4 } })]),
  });
  assert.deepEqual(r.corrections, []);
  assert.equal(r.dialogueAct, 'QUESTION');
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

test('C3 correction resolves a unique typed fact from conversation context', async () => {
  const inputCtx: BoundedUnderstandingContext = {
    user: [],
    conversation: [ref({
      id: 'session:last_bleeding_start',
      scope: 'conversation',
      memoryType: 'session',
      memoryKey: 'last_bleeding_start',
      payload: { value: '2026-11-01' },
    })],
    case: [],
  };

  const r = await svc.evaluate({ projectId: 'p', text: 'لا، قصدي 2026-11-02', context: inputCtx });

  assert.deepEqual(r.corrections, [{ target: 'last_bleeding_start', old: '2026-11-01', new: '2026-11-02' }]);
});

test('C4 correction does not guess between multiple typed facts', async () => {
  const inputCtx: BoundedUnderstandingContext = {
    user: [],
    conversation: [
      ref({ id: 'start', scope: 'conversation', memoryType: 'session', memoryKey: 'start_date', payload: { value: '2026-11-01' } }),
      ref({ id: 'end', scope: 'conversation', memoryType: 'session', memoryKey: 'end_date', payload: { value: '2026-11-03' } }),
    ],
    case: [],
  };

  const r = await svc.evaluate({ projectId: 'p', text: 'لا، قصدي 2026-11-02', context: inputCtx });

  assert.deepEqual(r.corrections, [{ new: '2026-11-02', targetAmbiguous: true }]);
});

test('admission round 2: equivalent boolean spellings keep correction targets ambiguous', async () => {
  const inputCtx = ctx([
    ref({ memoryKey: 'first', payload: { value: true } }),
    ref({ memoryKey: 'second', payload: { value: false } }),
  ]);
  for (const text of ['I meant yes', 'I meant correct', 'I meant yeah', 'I meant no', 'لا، قصدي كلا', 'لا، قصدي أي نعم', 'لا، قصدي إي نعم']) {
    const result = await svc.evaluate({ projectId: 'p', text, context: inputCtx });
    assert.equal(result.corrections[0]?.targetAmbiguous, true, text);
  }
});

test('a time in an ordinary question does not produce a correction', async () => {
  const r = await svc.evaluate({ projectId: 'p', text: 'Can I reschedule for 10:00?', context: ctx([ref()]) });

  assert.equal(r.dialogueAct, 'QUESTION');
  assert.deepEqual(r.corrections, []);
  assert.equal(r.facts.find((fact) => fact.key === 'time')?.value, '10:00');
});

test('a correction with two replacement times cannot resolve a target', async () => {
  for (const text of ['I meant 10:00 or 11:00', 'I meant at 10 or 11:00']) {
    const r = await svc.evaluate({ projectId: 'p', text, context: ctx([ref()]) });
    assert.equal(r.dialogueAct, 'CORRECTION');
    assert.deepEqual(r.corrections, [], text);
  }
});

test('ordinary minute-level clocks distinguish AM/PM tokens from word prefixes without emitting corrections', async () => {
  for (const [text, expected] of [
    ['Can I reschedule for 10:30 p.m.?', '22:30'],
    ['Is 12:30 ample time?', '12:30'],
  ]) {
    const r = await svc.evaluate({ projectId: 'p', text, context: ctx([ref()]) });
    assert.deepEqual(r.corrections, []);
    assert.equal(r.facts.find((fact) => fact.key === 'time')?.value, expected, text);
  }
});

test('Task 6: Arabic 12-hour clocks normalize to canonical 24-hour values', async () => {
  for (const [text, expected] of [
    ['الساعة 9 مساء', '21:00'],
    ['الساعة 12 صباحاً', '00:00'],
    ['الساعة 12 مساء', '12:00'],
  ]) {
    const result = await svc.evaluate({ projectId: 'p', text });
    assert.equal(result.facts.find((fact) => fact.key === 'time')?.value, expected, text);
  }
});

test('Task 6 fix round 1: minute clocks share bounded Arabic and meridiem normalization', async () => {
  for (const [text, expected] of [
    ['الساعة 9:30 مساء', '21:30'],
    ['الساعة ٩:٣٠ مساء', '21:30'],
    ['الساعة 12:30 صباحاً', '00:30'],
    ['الساعة 12 صباحاً', '00:00'],
    ['الساعة 12 مساء', '12:00'],
  ]) {
    const result = await svc.evaluate({ projectId: 'p', text });
    assert.equal(result.facts.find((fact) => fact.key === 'time')?.value, expected, text);
  }
});

test('Task 6 fix round 2: standalone Arabic meridiem is sufficient but a bare number is not', async () => {
  for (const [text, expected] of [
    ['12 صباحاً', '00:00'],
    ['12 مساء', '12:00'],
    ['١٢ صباحاً', '00:00'],
    ['١٢ مساء', '12:00'],
  ]) {
    const result = await svc.evaluate({ projectId: 'p', text });
    assert.equal(result.facts.find((fact) => fact.key === 'time')?.value, expected, text);
  }

  const bare = await svc.evaluate({ projectId: 'p', text: 'لدي 12 تفاحة' });
  assert.equal(bare.facts.some((fact) => fact.key === 'time'), false);
});

test('Task 6 fix round 2: time discovery requires token boundaries and complete consumption', async () => {
  for (const text of [
    'I selected that 9 pm option.',
    'At 9:999 I arrived.',
    'At 9:00:30 I arrived.',
    'At 9::00 I arrived.',
  ]) {
    const result = await svc.evaluate({ projectId: 'p', text });
    assert.equal(result.facts.some((fact) => fact.key === 'time'), false, text);
  }

  const valid = await svc.evaluate({ projectId: 'p', text: 'At 9:30 I arrived.' });
  assert.equal(valid.facts.find((fact) => fact.key === 'time')?.value, '09:30');
});

test('Task 6 fix round 2: a separator keeps undotted meridiem in the preceding statement clause', async () => {
  const result = await svc.evaluate({ projectId: 'p', text: 'At 12:30 am I woke up, can I go?' });
  assert.equal(result.dialogueAct, 'QUESTION');
  assert.equal(result.facts.find((fact) => fact.key === 'time')?.value, '00:30');
  assert.deepEqual(result.corrections, []);
});

test('Task 6 fix round 1: invalid clock minutes emit no advisory time', async () => {
  const result = await svc.evaluate({ projectId: 'p', text: 'At 12:99 pm I arrived.' });
  assert.equal(result.facts.some((fact) => fact.key === 'time'), false);
});

test('Task 6 fix round 1: dotted meridiem stays local to its statement clause', async () => {
  const result = await svc.evaluate({ projectId: 'p', text: 'At 12:30 a.m. I woke up. Can I go?' });
  assert.equal(result.dialogueAct, 'QUESTION');
  assert.equal(result.facts.find((fact) => fact.key === 'time')?.value, '00:30');
  assert.deepEqual(result.corrections, []);
});

test('Task 6: an English question-clause verb am is not consumed as a meridiem', async () => {
  const result = await svc.evaluate({ projectId: 'p', text: 'At 12:30 am I free?' });

  assert.equal(result.dialogueAct, 'QUESTION');
  assert.equal(result.facts.find((fact) => fact.key === 'time')?.value, '12:30');
  assert.deepEqual(result.corrections, []);

  const statement = await svc.evaluate({ projectId: 'p', text: 'At 12:30 am I woke up.' });
  assert.equal(statement.facts.find((fact) => fact.key === 'time')?.value, '00:30', 'a normal AM statement keeps its meridiem');
});

test('an English negative prefix still allows a date correction to resolve', async () => {
  const r = await svc.evaluate({
    projectId: 'p',
    text: 'No, I meant 2026-11-02.',
    context: ctx([ref({ memoryKey: 'appointment_date', payload: { value: '2026-11-01' } })]),
  });

  assert.equal(r.dialogueAct, 'CORRECTION');
  assert.deepEqual(r.corrections, [{ target: 'appointment_date', old: '2026-11-01', new: '2026-11-02' }]);
});

for (const text of [
  'I meant: not 10:00',
  'Sorry, I meant maybe 10:00',
  'I meant 10:00 maybe',
  'آسفة، قصدي: ربما 10:00',
  'I meant: not 10:30 AM',
  'Sorry, I meant maybe 10:30 a.m.',
]) {
  test(`a non-definite replacement clause has no time correction: ${text}`, async () => {
    const r = await svc.evaluate({ projectId: 'p', text, context: ctx([ref()]) });

    assert.equal(r.dialogueAct, 'CORRECTION');
    assert.deepEqual(r.corrections, []);
  });
}

test('an embedded correction marker after an uncertain preface has no replacement', async () => {
  const r = await svc.evaluate({
    projectId: 'p',
    text: "I'm not sure I meant 2026-11-02",
    context: ctx([ref({ memoryKey: 'appointment_date', payload: { value: '2026-11-01' } })]),
  });

  assert.deepEqual(r.corrections, []);
});

for (const text of [
  'I meant, 10:00',
  'No, I meant: 10:00',
  'Sorry, I meant 10:00',
  'آسفة، قصدي: 10:00',
  'I meant at 10:00',
  'I meant at 10 pm',
]) {
  test(`an explicit punctuated or apology correction resolves the time: ${text}`, async () => {
    const r = await svc.evaluate({ projectId: 'p', text, context: ctx([ref()]) });

    assert.equal(r.dialogueAct, 'CORRECTION');
    assert.deepEqual(r.corrections, [{ target: 'preferred_time', old: '09:00', new: text.endsWith('pm') ? '22:00' : '10:00' }]);
  });
}

for (const [text, expected] of [
  ['I meant, 10:30 AM', '10:30'],
  ['No, I meant: at 10:30 a.m.', '10:30'],
  ['Sorry, I meant 10:30 AM', '10:30'],
  ['I meant 10:30 PM', '22:30'],
  ['I meant at 12:30 a.m.', '00:30'],
  ['I meant at 12:30 p.m.', '12:30'],
]) {
  test(`a definite minute-level AM/PM correction resolves the normalized time: ${text}`, async () => {
    const inputCtx = ctx([ref()]);
    const r = await svc.evaluate({ projectId: 'p', text, context: inputCtx });

    assert.equal(r.dialogueAct, 'CORRECTION');
    assert.deepEqual(r.corrections, [{ target: 'preferred_time', old: '09:00', new: expected }]);
    assert.deepEqual(inputCtx, ctx([ref()]), 'interpretation does not mutate the supplied facts');
  });
}

for (const text of ['I meant 10:30 AM or 11:30 AM', "Sorry, I'm not sure I meant 10:30 AM"]) {
  test(`an alternative or uncertain minute-level AM/PM correction stays inert: ${text}`, async () => {
    const r = await svc.evaluate({ projectId: 'p', text, context: ctx([ref()]) });
    assert.deepEqual(r.corrections, []);
  });
}

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
