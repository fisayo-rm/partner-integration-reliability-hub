# Partner outage

## Symptoms

`delivery.retry_scheduled` rises, partner timeout or 5xx outcomes accumulate, and the affected destination's circuit transitions toward open while unrelated destinations remain healthy.

## Evidence

Local: run `pnpm demo:m06` against the running Compose profile and inspect the operator delivery detail plus mock captures. Hosted: inspect the PIRH dashboard and query redacted Lambda logs for the correlation ID using `aws logs start-query --profile pirh-inspection` against known demo log groups.

## Safe actions

Confirm partner status, preserve queue buffering, inspect redacted immutable attempts, and let the configured retry, rate-limit, and circuit policy operate. After recovery, submit an authorized operator replay with a reason when eligible.

## Unsafe actions

Do not delete queue messages, edit attempt history, bypass authentication, or disable retry/circuit policy merely to force traffic through.

## Recovery verification

The replayed delivery reaches a successful terminal state, the original event and delivery remain immutable, and queue age/error metrics return to their normal trend.

## Recorded exercise

Passed locally on 2026-08-27 through `PIRH_RUN_M12_LOAD=1 pnpm local:verify:default`: `demo:m06` forced Beta 503, observed dead-lettering, restored the partner, and completed an authorized successful replay.
