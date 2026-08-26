# Partner outage

Symptoms: `delivery.retry_scheduled` rises and partner timeout/5xx attempt history grows.

Evidence: local `pnpm demo:m06`; hosted CloudWatch Logs Insights query on `delivery.completed|delivery.failed` and the PIRH dashboard.

Safe actions: confirm the partner status, preserve queue buffering, inspect redacted attempts, and let normal retry/circuit policy operate. Unsafe: deleting queue messages, editing attempt history, or disabling authentication to test recovery.

Recovery verification: a new signed event reaches a successful terminal delivery. Exercise result: pending M12 deep-verification run.
