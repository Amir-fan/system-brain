# Naqaa Cycle Prediction API

## Endpoint and ownership

`POST /v1/projects/{projectId}/naqaa/cycle-predictions`

The caller must present an authenticated actor who is an active member of the target KIP project. KIP authenticates and authorizes before reading the menstrual-history body. The operation is deterministic and stateless: KIP stores no cycle input or prediction and logs no submitted dates. Naqaa owns canonical history, corrections, calendar persistence, notification scheduling, overdue presentation, and reconciliation.

Use `Content-Type: application/json`. The decoded JSON body is limited to 1,000,000 characters, and `confirmedCycleStarts` is limited to 120 entries.

## Request

Only these fields are accepted:

| Field | Type | Rules |
| --- | --- | --- |
| `lastCycleStart` | string | Required strict `YYYY-MM-DD`; latest confirmed start; `1900-01-01` through the server's current UTC date. |
| `typicalBleedingDays` | integer | Required, 1 through 366. Used only for the bleeding-end estimate. |
| `typicalCycleDays` | integer | Optional, 1 through 366. Start-to-start length; never replaced by bleeding duration. |
| `regularity` | string | Required: `regular`, `irregular`, or `unknown`. |
| `confirmedCycleStarts` | string[] | Optional confirmed dates, any order, no duplicates, at most 120. Its latest value must equal `lastCycleStart`. |

The request rejects caller clocks, `subjectId`, scanner evidence, fiqh state, and any other field.

Synthetic example:

```json
{
  "lastCycleStart": "2026-11-01",
  "typicalBleedingDays": 7,
  "typicalCycleDays": 30,
  "regularity": "regular",
  "confirmedCycleStarts": ["2026-10-02", "2026-11-01"]
}
```

## Successful response

```json
{
  "ok": true,
  "status": 200,
  "data": {
    "predictedNextStart": "2026-12-01",
    "windowStart": "2026-11-30",
    "windowEnd": "2026-12-02",
    "estimatedBleedingEnd": "2026-11-07",
    "reliability": "history_based",
    "basis": {
      "latestCycleStart": "2026-11-01",
      "baselineCycleDays": 30,
      "usedDefaultCycleDays": false,
      "actualIntervalsDays": [30],
      "weightedExpectedCycleDays": 30,
      "windowOffsetsDays": { "min": 29, "max": 31 }
    },
    "integration": {
      "contractVersion": "naqaa-cycle-prediction-v1",
      "inputFingerprint": "sha256:83903718d58e44bcd7c55638f8e118c53c1c01427c5ff7dffa7b262b55ee9342",
      "forecast": {
        "predictedNextStart": "2026-12-01",
        "windowStart": "2026-11-30",
        "windowEnd": "2026-12-02",
        "reliability": "history_based"
      },
      "estimatedBleedingEnd": "2026-11-07"
    },
    "fiqhImpact": "none",
    "purificationDetermination": false
  }
}
```

`estimatedBleedingEnd` counts the latest start as day one. It is educational scheduling information, not a purification date or fiqh ruling.

## Reliability and calculation

- `initial`: no measured interval exists and an explicit `typicalCycleDays` baseline was used.
- `needs_more_data`: no measured interval exists and the disclosed 28-day default was used.
- `history_based`: at least one confirmed start-to-start interval contributed.

The central cycle length is a rounded recency-weighted mean. The baseline has weight 1; chronological measured intervals have weights 2 through `n + 1`. With no history, the range is ±2 days around an explicit baseline or ±4 around the 28-day default. One measured interval uses central ±1. Two or more use observed minimum/maximum and union that range with central ±1. `irregular` additionally unions central ±4. The lower offset is always at least one day, so the forecast window remains strictly after the latest confirmed start.

All date arithmetic uses UTC calendar days. KIP returns the immediate next expected start after the latest confirmed start and does not roll an overdue prediction forward.

## Fingerprint and corrections

`inputFingerprint` is SHA-256 over a fixed-order canonical object containing the contract version, onboarding values, regularity, and sorted confirmed starts. Equivalent history order produces the same fingerprint. Any material correction produces a fresh calculation and normally a different fingerprint. Naqaa should compare the version and fingerprint with its current calendar/notification record and reconcile those records transactionally; KIP does not perform that write.

## Errors

Errors use `{ "ok": false, "status": <number>, "error": { "category", "message", "code"? } }`.

| HTTP | Category | Meaning |
| --- | --- | --- |
| 400 | `validation` | Invalid JSON/media/size (`PREDICTION_REQUEST_INVALID`) or a stable domain validation code such as `PREDICTION_INPUT_INVALID`, `PREDICTION_DATE_INVALID`, `PREDICTION_DATE_OUT_OF_RANGE`, `PREDICTION_DATE_IN_FUTURE`, `PREDICTION_NUMBER_INVALID`, `PREDICTION_NUMBER_OUT_OF_RANGE`, `PREDICTION_HISTORY_TOO_LONG`, `PREDICTION_HISTORY_DUPLICATE`, or `PREDICTION_LATEST_START_MISMATCH`. |
| 401 | `authorization` | Missing or invalid bearer authentication. |
| 403 | `authorization` | Project inactive or actor not a member. |
| 404 | `not_found` | Project, route, or optional capability unavailable. |
| 500 | `runtime` | Generic internal failure; no request dates, keys, provider details, or stack traces are returned. |

The endpoint has no numeric confidence percentage, model/provider call, persistence write, Memory lookup, scanner input, or fiqh decision side effect.
