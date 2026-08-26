# Stuck outbox

Symptoms: accepted events have unpublished outbox records or outbox age rises.

Evidence: local `pnpm demo:m07` and outbox-worker logs; hosted PIRH outbox metrics, DynamoDB stream failures, and reconciler logs. Safe actions: inspect publisher failure evidence and let the reconciler claim unpublished records. Unsafe: manually mark records published or directly send reconstructed queue messages.

Recovery verification: one publish trace is visible and the original outbox record is marked by normal worker processing. Exercise result: pending M12 deep-verification run.
