# ADR-019 — Understanding Foundation V1

Status: accepted
Slice: K19

## Decision
Introduce ONE generic, deterministic Understanding layer that sits between raw user
input/context and future Skills. It interprets WHAT the current input means in the
available bounded context and whether enough context exists to continue safely. It
does NOT answer, decide domain facts, execute skills, train, or act as an agent.

Boundaries (strict):
- Memory = what KIP remembers.
- Understanding = what KIP believes the CURRENT INPUT means in available context.
- Skills = what KIP knows HOW TO DO with that understood request (not yet built).
- Knowledge = evidence/information available to support later work.
- Learning = how models/skills improve over time (not yet built).

## Responsibilities (only)
1. Dialogue Act / Input Function
2. Reference Resolution
3. Correction Detection
4. Issue Decomposition
5. Material Ambiguity Detection
6. Context Assembly
7. Structured Understanding Result

## Model usage
Deterministic logic is used for obvious confirmations, rejections, corrections,
simple temporal expressions, explicit compound inputs and reference resolution.
Target = **0 model calls per evaluation** in V1. If a broader NLU model is ever
required it must go through the existing Model Gateway + Model Assignment — never a
direct provider SDK. Do not add multiple model calls.

## Memory integration
Understanding READS bounded relevant memory via the existing MemoryService contract
(small per-scope limits; never a full dump). It NEVER writes durable memory: a
correction yields a structured interpretation; an explicit caller decides whether to
call Memory.supersede(). UNDERSTAND stays separate from REMEMBER.

## Result
`UnderstandingResult { status: CLEAR | NEEDS_CLARIFICATION, language, dialogueAct,
issues, references, corrections, facts, ambiguity, clarification?, contextUsed }`.
Material ambiguity → NEEDS_CLARIFICATION with a short, specific, single-decision
question. No answer is generated while a material ambiguity remains.
