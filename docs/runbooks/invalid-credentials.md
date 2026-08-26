# Invalid credentials

Symptoms: `SECRET_NOT_FOUND` or `OAUTH_TOKEN_ERROR` in immutable attempt evidence.

Evidence: local delivery detail and `pnpm demo:m06`; hosted redacted Lambda logs and delivery history. Safe actions: rotate or rebind the logical secret alias, then submit an authorized replay with a reason. Unsafe: reading, copying, or logging secret values; editing old attempts.

Recovery verification: replay succeeds and original history remains immutable. Exercise result: pending M12 deep-verification run.
