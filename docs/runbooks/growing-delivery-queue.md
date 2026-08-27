# Growing delivery queue

## Symptoms

Visible-message count and oldest-message age rise while destination success lags. A healthy destination must not be starved by one slow or rate-limited destination.

## Evidence

Local: inspect `docker compose ps`, `load-artifacts/*.json`, and Grafana when the observability profile is running. Hosted: inspect the PIRH dashboard, native SQS oldest-message and visible-message metrics, and Lambda concurrency with `aws cloudwatch get-metric-data --profile pirh-inspection ...`.

## Safe actions

Identify the destination-specific cause, inspect circuit and rate state, and increase only bounded worker capacity after a quota review. Preserve messages and allow healthy destinations to continue.

## Unsafe actions

Do not purge queues, globally disable rate/circuit policy, or manually alter delivery state.

## Recovery verification

Visible count and age trend down, healthy-destination success continues, and terminal outcomes remain one-per-delivery.

## Recorded exercise

Passed locally on 2026-08-27. The isolated 100/s ingestion-only scenario accepted 6,001 events at 100.02/s with zero dropped iterations and left 226 routing messages plus one in flight while workers were paused. Slow-Beta and rate-limited-hot scenarios also passed without final acceptance failures.
