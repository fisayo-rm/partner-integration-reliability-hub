# Growing delivery queue

Symptoms: queue age/visible-message metrics rise while healthy destinations lag.

Evidence: local `docker compose ps` and Grafana; hosted SQS queue-age dashboard widgets and Lambda concurrency metrics. Safe actions: identify the destination-specific cause, inspect circuit/rate state, and increase bounded worker capacity only after quota review. Unsafe: purge queues or bypass rate/circuit policy.

Recovery verification: queue age and visible count trend to zero with normal success metrics. Exercise result: pending M12 deep-verification run.
