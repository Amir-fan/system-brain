# Task 4 Addendum — Material Fact Admission

## Status

Approved execution addendum for the release-blocking Task 4 breaker found during client hardening.

## Problem

Conversation currently lets an open-ended linguistic classification decide whether text may become a `CERTAIN` material fact. Five repair rounds proved that expanding question-word and punctuation regexes creates reciprocal false positives and bypasses: common questions can still bind compatible numbers or free text, while valid Arabic answers and confirmations can be rejected.

This is a misplaced safety seam. Understanding may classify language for UX and routing, but it must not authorize facts used for personal fiqh labels.

## Considered Interfaces

Three independent designs were compared:

1. A small `MaterialFactAdmission` Module with `admit` and a confirmed-fact predicate.
2. A flexible event/revision Module with opaque interaction identifiers and replay protection.
3. A deeper Conversation Module whose external Interface accepts explicit interaction answers.

All three agreed on the invariant: certainty comes from a server-owned answer contract plus explicit user intent, never from `dialogueAct` or extracted candidates. The full opaque-interaction protocol is strongest but would expand the wire contract and client migration beyond the current repository scope.

## Chosen Seam

Add one in-process, pure `MaterialFactAdmission` Module at the seam immediately before Conversation mutates session facts. Keep the existing Conversation Interface and structured `answers` payload for compatibility.

The Module owns:

- structured-answer validation against the declared interaction;
- exact whole-value parsing for closed raw-answer types;
- canonical uncertainty handling;
- bounded explicit-correction validation;
- the predicate for a confirmed material fact.

Understanding remains advisory. Its dialogue act and candidates cannot authorize certainty.

## Admission Rules

1. A structured answer is explicit intent. It may become `CERTAIN/user_answer` only when its key has a valid declared contract and its value satisfies that contract.
2. A raw message may answer a pending closed interaction only when the whole normalized message is the answer:
   - `yes_no`: finite bilingual whole-answer vocabulary, including Gulf Arabic `أي نعم` / `إي نعم`;
   - `number`: whole numeric literal only;
   - `duration`: whole numeric literal or whole number-plus-generic-unit expression;
   - `date`: whole valid ISO-style date;
   - choices: exact declared option(s) only.
3. Raw `free_text` never becomes `CERTAIN`. The existing structured answer path is required for arbitrary text.
4. Unknown or uncertainty selections remain `UNKNOWN` and never satisfy readiness.
5. Questions, prose containing a compatible scalar, candidate extraction, and skill-bound values are proposals only.
6. Natural corrections may become certain only when the complete turn matches a bounded explicit-correction form, targets an existing or pending fact, satisfies its contract/type, and contains no question punctuation. Otherwise they are inert proposals.
7. Skill `caseFacts` are never upgraded to confirmed user answers by Conversation.
8. A personal Minimal label requires every declared material key to be present with `certainty=CERTAIN`, `provenance=user_answer`, and a usable value.

## Ordering

1. Load and authorize the session.
2. Admit structured answers against declared contracts.
3. Run Understanding for advisory interpretation.
4. Admit an exact raw answer to the current pending contract, if applicable.
5. Admit only bounded explicit corrections.
6. Assemble context; Memory remains lower precedence.
7. Execute the skill with candidates marked non-authoritative.
8. Persist only admission-authorized facts as confirmed user answers.
9. Invalidate grounded results only when an accepted material value actually changes.

## Compatibility and Tradeoffs

- No dependency, service, model call, database table, or credential change.
- Existing structured `answers` callers continue to work.
- Bare numbers, dates, durations, choices, and yes/no replies remain convenient.
- Arbitrary raw free text and narrative facts may require a structured answer or an additional clarification. This is the intentional cost of removing linguistic guesswork from an authorization decision.
- Understanding classification can still be imperfect, but errors affect UX rather than personal-ruling authorization.

## Verification Boundary

Tests must prove safety despite intentionally wrong Understanding classifications. They must cover unlisted Arabic/English questions, quotes/emoji/greetings, Gulf confirmations, Arabic-Indic digits, structured free text, uncertainty, correction forms, skill proposals, and the Minimal provenance gate.
