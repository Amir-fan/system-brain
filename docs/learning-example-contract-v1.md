# Learning Example Contract V1

Status: design note (no persistence, no training — K21 reservation only)

## Purpose
A project-agnostic contract for a single future Learning Example. The Learning engine
must NOT understand Naqaa (or any domain) semantics; a Naqaa scan may emit
`task = "naqaa.scan.assessment"`, another project may emit `task = "support.ticket.routing"`.

## LearningExampleV1 (smallest extensible shape)

```ts
interface LearningExampleV1 {
  id?: string;
  projectId: string;
  task: string;                    // e.g. "naqaa.scan.assessment"
  occurredAt: string;

  inputReference?: string;         // optional pointer (never raw media in the example)
  observation: unknown;            // structured observation (domain schema, e.g. NaqaaScanObservationV1)

  contextSnapshot: unknown;        // purposeful, BOUNDED context (never a full history dump)

  modelVersion: string;
  modelOutput: unknown;

  interventions?: Array<{ key: string; question?: string }>;  // questions asked
  answers?: Array<{ key: string; value: unknown }>;

  outcome?: unknown;               // later, if available
  label?: unknown;                 // later, if available
  labelProvenance?: 'user' | 'system_derived' | 'reviewed' | 'unverified';

  verificationStatus: 'unverified' | 'user_confirmed' | 'system_derived' | 'reviewed';
  quality: 'good' | 'limited' | 'unusable';

  eligibility: {                     // privacy/consent boundary
    consentGranted: boolean;
    eligible: boolean;
    reason?: string;
  };
}
```

## Boundaries
- USER MEMORY = what we know about this individual (K18).
- OBSERVATION HISTORY = what occurred during scans/events (future Naqaa observation persistence).
- LEARNING DATASET = eligible examples selected from many historical cases (future).

A scan observation is NOT automatically a training example. Eligibility may depend on
consent, privacy policy, verification quality, outcome availability, label provenance,
data quality. K21 implements NO selection, NO dataset persistence, NO training, NO model
promotion. User corrections are NOT unquestionable ground truth — labels carry
`labelProvenance` / `verificationStatus`.

## No silent self-learning
Production flow must never become: incoming scan → auto-retrain → replace production
model. Future gated lifecycle: COLLECT → VALIDATE → LABEL → DATASET VERSION →
TRAIN CANDIDATE → EVALUATE → COMPARE → APPROVE/PROMOTE → MONITOR.
