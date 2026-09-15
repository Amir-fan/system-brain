# ADR-021 — Naqaa Scanner Foundation V1

Status: accepted
Slice: K21

## Decision
Introduce Naqaa's first real domain Skill — `naqaa.scanner` v1 — running through the
existing K20 Skills Runtime and the KIP Model Gateway. The Scanner transforms available
scan input + bounded context into a structured observation, assesses sufficiency,
identifies missing information, and returns a structured scanner result. It does NOT
make Fiqh decisions and does NOT self-learn.

Boundaries (strict):
- SCANNER INPUT = scan/media reference + available contextual metadata.
- OBSERVATION = what was observed/inferred/provided from this scan/context.
- SCANNER SKILL = interprets observations and determines information sufficiency.
- MEMORY = durable user/case contextual continuity.
- UNDERSTANDING = language understanding (not scanner logic).
- FIQH SKILL = future religious/domain decision layer (NOT implemented).
- LEARNING DATASET = future multi-case dataset for model improvement (NOT implemented).

Also:
- Memory != Scan Observation
- Scan Observation != Fiqh Decision
- Observation History != Learning Dataset
- Learning Dataset != production Memory
- Scanner Skill != Fiqh Skill

## Vision
Any vision call goes Skill → Model Gateway → Model Assignment → Provider. K21 added the
smallest project-agnostic multimodal extension to the Model Gateway: `ModelContentPart`
(text | image data URL) carried as `ModelGatewayInput.input.parts`; provider-specific
conversion lives only in the provider adapter. Verified: real controlled red-PNG →
`vision_scan` (openrouter / google/gemini-3.5-flash) → structured JSON. Images are data
URLs, never persisted to Memory, never put in a public bucket.

## Feature model
Five groups (color, physical, texture, spatial, contextual). Every meaningful feature
is `{ value, status, confidence?, source, method?, unit? }` with statuses
observed | inferred | user_provided | unavailable. Physical properties an image cannot
reliably measure (viscosity, density, ...) are `inferred` or `unavailable`, never
`observed`. UNKNOWN is never collapsed into FALSE (e.g. unavailable pregnancy status is
not `pregnant=false`).

## No Fiqh, no silent learning
The scanner returns observations/quality/sufficiency/missing-information/question-need —
never hayd/istihada/nifas/purity/prayer/fasting rulings. Production flow must NEVER be
incoming-scan → auto-retrain → replace production model. Future: COLLECT → VALIDATE →
LABEL → VERSION → TRAIN → EVALUATE → COMPARE → PROMOTE → MONITOR. K21 implements none of
the training/promotion pipeline.
