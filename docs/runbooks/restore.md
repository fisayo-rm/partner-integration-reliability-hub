# Restore

## Symptoms

A tenant needs controlled recovery into an empty isolated environment after an incident. Recovery snapshots are not configuration portability bundles and must never promote an environment or import in place.

## Evidence

Local: run `pnpm restore:drill`, or use `pnpm ops:backup --environment local --tenant <id> --output <dir>` followed by `pnpm ops:restore --source <manifest> --target-environment restore-test --core-table pirh-restore-core --audit-table pirh-restore-audit --allow-restore`. Hosted: inspect known demo stacks and redacted logs with `--profile pirh-inspection`; do not retrieve secret values.

## Safe actions

Create fresh empty `pirh-restore-*` tables, verify manifest checksums, restore only with explicit acknowledgement, bind newly generated local-only aliases, and start restored services in rebind-only mode.

## Unsafe actions

Do not target demo, source, or shared tables; omit the acknowledgement; copy local secret records; or run an in-place import.

## Recovery verification

Compare record counts, key digests, and logical references; verify that the snapshot excludes local secret records; then submit a signed event against the restored API.

## Recorded exercise

Passed locally on 2026-08-27 through `pnpm restore:drill`: 53 core and 10 audit records restored into fresh tables with matching key digests and three logical aliases. Six fresh local-secret/head records were rebound. Observed RPO was 849 ms and RTO was 22,112 ms; the restored API accepted a newly signed event.
