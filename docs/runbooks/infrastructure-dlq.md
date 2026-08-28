# Infrastructure DLQ

## Symptoms

A routing, delivery, or stream-failure DLQ count is non-zero. The immediate question is whether each record is malformed/stale or a recoverable transient failure.

## Evidence

Local: inspect ElasticMQ queue attributes with the bootstrap container and worker logs. Hosted: inspect the demo SQS DLQ alarm, queue metrics, and the correlated worker log group using `aws --profile pirh-inspection` read commands.

## Safe actions

Classify a bounded sample, correct the producer or configuration cause, and redrive only a bounded observed batch after confirming idempotency and replay semantics.

## Unsafe actions

Do not blind-redrive, purge the queue, or manually edit event-table records.

## Recovery verification

Each redriven record has exactly one durable outcome and the DLQ count returns to zero without duplicate downstream calls.

## Recorded exercise

Passed locally on 2026-08-27 through `tests/m12/worker-handlers.test.ts` in the successful deep verifier. It exercised malformed and stale messages, partial-batch failure isolation, and retryable failure reporting; stale work was acknowledged rather than amplified.
