# Invalid credentials

## Symptoms

Immutable delivery evidence contains `SECRET_NOT_FOUND` or `OAUTH_TOKEN_ERROR`; attempts are retryable or terminal according to policy and configured values never appear in logs.

## Evidence

Local: use `pnpm demo:m06` and the operator delivery detail. Hosted: inspect redacted delivery history and the known demo Lambda log groups with `--profile pirh-inspection` only.

## Safe actions

Rotate or rebind the logical secret alias through the approved secret workflow, confirm the correction, then submit an authorized replay with a reason.

## Unsafe actions

Never read, copy, put in a ticket, or log a secret value. Do not edit old attempts or mutate historical delivery state.

## Recovery verification

The replay succeeds using the new alias binding and the immutable original attempt and event status remain unchanged.

## Recorded exercise

Passed locally on 2026-08-27 through the `demo:m06` run inside successful deep local verification. `tests/m12/worker-handlers.test.ts` also exercises the missing-secret handler path without exposing values.
