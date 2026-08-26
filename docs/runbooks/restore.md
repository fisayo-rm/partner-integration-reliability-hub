# Restore

Symptoms: a tenant requires isolated state recovery after a controlled incident.

Evidence: `pnpm ops:backup --environment local --tenant <id> --output backups/<id>` writes checksum-bearing manifest and gzip files. Safe actions: create fresh empty `pirh-restore-*` tables, verify checksums, then run `pnpm ops:restore --source <manifest> --target-environment restore-test --core-table pirh-restore-core --audit-table pirh-restore-audit --allow-restore`. Unsafe: target demo/source/shared tables, omit the acknowledgement, copy local secret records, or perform in-place import.

Recovery verification: compare counts/key digests, bind fresh local-only aliases, start with seed overwrite disabled, and submit a signed event. Exercise result: pending M12 deep-verification run; record RPO/RTO there.
