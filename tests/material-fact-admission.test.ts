import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RequirementInteraction } from '../src/core/readiness/readiness.ts';

import {
  admitMaterialAnswer,
  admitMaterialCorrection,
  isConfirmedMaterialFact,
} from '../src/core/readiness/material-fact-admission.ts';

test('raw closed interactions admit only complete values', () => {
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'number' }, source: 'raw', value: '٦' }), {
    outcome: 'accepted', value: 6, certainty: 'CERTAIN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'duration' }, source: 'raw', value: '٦ أيام' }), {
    outcome: 'accepted', value: '٦ أيام', certainty: 'CERTAIN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'date' }, source: 'raw', value: '2026-2-03' }), {
    outcome: 'accepted', value: '2026-02-03', certainty: 'CERTAIN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'single_choice', options: ['الأول', 'الثاني'] }, source: 'raw', value: 'الثاني' }), {
    outcome: 'accepted', value: 'الثاني', certainty: 'CERTAIN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'multiple_choice', options: ['الأول', 'الثاني'] }, source: 'raw', value: 'الأول' }), {
    outcome: 'accepted', value: ['الأول'], certainty: 'CERTAIN',
  });
});

for (const prose of ['Could I wait 6 days', 'السلام عليكم كم يوم أحتاج بعد 6 أيام', '6?', 'من ٦ أيام']) {
  test(`raw scalar prose is ignored: ${prose}`, () => {
    assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'duration' }, source: 'raw', value: prose }), { outcome: 'ignored' });
  });
}

test('yes/no admission is interaction-specific and supports Gulf Arabic', () => {
  for (const value of ['أي نعم', 'إي نعم', 'اي نعم', 'yes']) {
    assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'yes_no' }, source: 'raw', value }), {
      outcome: 'accepted', value: true, certainty: 'CERTAIN',
    });
  }
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'yes_no' }, source: 'raw', value: 'ما لون الدم' }), { outcome: 'ignored' });
});

test('raw free text is inert while structured free text is explicit intent', () => {
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'free_text' }, source: 'raw', value: 'ما نزل دم' }), { outcome: 'ignored' });
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'free_text' }, source: 'structured', value: 'ما نزل دم' }), {
    outcome: 'accepted', value: 'ما نزل دم', certainty: 'CERTAIN',
  });
});

test('uncertainty and malformed contracts fail closed', () => {
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'multiple_choice', options: ['الأول', 'الثاني', 'غير متأكدة'] }, source: 'structured', value: ['الأول', 'غير متأكدة'] }), {
    outcome: 'unknown', value: 'UNKNOWN', certainty: 'UNKNOWN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction: undefined, source: 'structured', value: 6 }), { outcome: 'ignored' });
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'date' }, source: 'raw', value: '2026-02-30' }), { outcome: 'ignored' });
});

test('a structured answer still needs a whole value of the declared type', () => {
  for (const [type, value] of [['number', 'Could I wait 6 days'], ['duration', '6 cups'], ['duration', -1], ['free_text', '[]']] as const) {
    assert.deepEqual(admitMaterialAnswer({ interaction: { type }, source: 'structured', value }), { outcome: 'ignored' });
  }
  assert.deepEqual(admitMaterialAnswer({
    interaction: { type: 'multiple_choice', options: ['one', 'two'] },
    source: 'structured', value: ['one', null, ''],
  }), { outcome: 'ignored' });
});

test('a whole raw multiple-choice reply can select more than one declared option', () => {
  const interaction = { type: 'multiple_choice', options: ['الأول', 'الثاني'] } as const;
  assert.deepEqual(admitMaterialAnswer({
    interaction: { ...interaction, options: [...interaction.options] }, source: 'raw', value: 'الأول، الثاني',
  }), { outcome: 'accepted', value: ['الأول', 'الثاني'], certainty: 'CERTAIN' });
});

test('a duration contract rejects negative elapsed time', () => {
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'duration' }, source: 'raw', value: '-1' }), { outcome: 'ignored' });
  assert.deepEqual(admitMaterialAnswer({ interaction: { type: 'duration' }, source: 'raw', value: '-1 day' }), { outcome: 'ignored' });
});

test('admission hardening: complete uncertainty with terminal punctuation remains unknown', () => {
  const interaction = { type: 'number' } as const;
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value: "I don't know." }), {
    outcome: 'unknown', value: 'UNKNOWN', certainty: 'UNKNOWN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value: "I don't know if I should wait 6 days." }), { outcome: 'ignored' });
});

test('admission hardening: structured free text is never confirmed after truncation', () => {
  const interaction = { type: 'free_text' } as const;
  const withinLimit = 'x'.repeat(200);
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'structured', value: withinLimit }), {
    outcome: 'accepted', value: withinLimit, certainty: 'CERTAIN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'structured', value: `${withinLimit}y` }), { outcome: 'ignored' });
});

test('admission round 2: repeated terminal punctuation and symbols preserve complete uncertainty', () => {
  const interaction = { type: 'yes_no' } as const;
  for (const value of ["I don't know...", 'غير متأكدة!!', 'not sure 🙏']) {
    assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value }), {
      outcome: 'unknown', value: 'UNKNOWN', certainty: 'UNKNOWN',
    }, value);
  }
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value: "I don't know what it means..." }), { outcome: 'ignored' });
});

test('admission round 2: closed time values normalize whole clocks and reject prose', () => {
  const interaction = { type: 'time' } as const;
  for (const [value, expected] of [['٠٩:٣٠', '09:30'], ['12:30 AM', '00:30'], ['10:30 p.m.', '22:30']]) {
    assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value }), { outcome: 'accepted', value: expected, certainty: 'CERTAIN' });
  }
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value: 'At 12:30 am I free?' }), { outcome: 'ignored' });
});

test('admission round 3: long terminal punctuation does not obscure bounded uncertainty', () => {
  const interaction = { type: 'yes_no' } as const;
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value: `I don't know${'.'.repeat(33)}` }), {
    outcome: 'unknown', value: 'UNKNOWN', certainty: 'UNKNOWN',
  });
  assert.deepEqual(admitMaterialAnswer({ interaction, source: 'raw', value: `I don't know which answer${'.'.repeat(33)}` }), { outcome: 'ignored' });
});

test('only bounded non-question correction statements authorize correction application', () => {
  const admit = (text: string, previous: number | string, interaction?: RequirementInteraction) => admitMaterialCorrection({
    text, facts: { observation: previous }, proposals: [{ target: 'observation', new: 'advisory value' }],
    contractFor: () => interaction, canCorrectLegacyFact: () => true,
  });
  for (const text of ['لا، قصدي 6', 'No, I meant: 6']) {
    assert.deepEqual(admit(text, 5), { outcome: 'accepted', key: 'observation', value: 6, interaction: { type: 'number' } }, text);
  }
  for (const [text, expected] of [['Sorry, I meant 10:30 AM', '10:30'], ['آسفة، قصدي: 10:00', '10:00']]) {
    assert.deepEqual(admit(text, '09:00', { type: 'time' }), { outcome: 'accepted', key: 'observation', value: expected, interaction: { type: 'time' } }, text);
    assert.deepEqual(admit(text, '09:00'), { outcome: 'unproven_contract', key: 'observation' }, text);
  }
  assert.deepEqual(admit('I meant 2026-11-02', '2026-11-01'), { outcome: 'unproven_contract', key: 'observation' });
  assert.deepEqual(admit('I meant 6', '5'), { outcome: 'unproven_contract', key: 'observation' }, 'a numeric-looking string may be a literal choice');
  for (const text of ['I mean 6?', 'Could I mean 6', "I'm not sure I meant 6", 'قصدي؟ 6', 'I meant 6 and then what']) {
    assert.equal(admit(text, 5), undefined, text);
  }
});

test('confirmed material facts require usable CERTAIN user-answer provenance', () => {
  assert.equal(isConfirmedMaterialFact(0, { certainty: 'CERTAIN', provenance: 'user_answer' }), true);
  assert.equal(isConfirmedMaterialFact(false, { certainty: 'CERTAIN', provenance: 'user_answer' }), true);
  assert.equal(isConfirmedMaterialFact('value', { certainty: 'CERTAIN', provenance: 'user_statement' }), false);
  assert.equal(isConfirmedMaterialFact('value', { certainty: 'UNCERTAIN', provenance: 'user_answer' }), false);
  assert.equal(isConfirmedMaterialFact('UNKNOWN', { certainty: 'CERTAIN', provenance: 'user_answer' }), false);
});
