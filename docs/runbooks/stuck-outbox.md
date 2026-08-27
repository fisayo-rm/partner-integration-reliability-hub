# Stuck outbox

## Symptoms

Accepted events have unpublished outbox records, the oldest unpublished age rises, or the outbox reconciler logs conditional ownership conflicts.

## Evidence

Local: run the acceptance-before-partner proof inside `pnpm local:verify` and inspect outbox-worker/reconciler logs. Hosted: inspect PIRH outbox metrics, DynamoDB stream failure metrics, and reconciler logs using the inspection profile.

## Safe actions

Inspect publisher failure evidence and allow the normal reconciler to claim unpublished records. Preserve the original outbox record and correlation ID.

## Unsafe actions

Do not manually mark a record published and do not synthesize a replacement queue message outside normal outbox processing.

## Recovery verification

One normal publish trace is visible, the record is marked by the worker, and the downstream call occurs only after durable acceptance.

## Recorded exercise

Passed locally on 2026-08-27 in the successful deep verifier. It stopped the outbox worker, received HTTP 202 for a signed event, verified no partner capture occurred while publication was paused, and resumed normal processing.
