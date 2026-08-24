import { tick } from "./index.js";

/** EventBridge schedule target. Reconciliation is idempotent by outbox state. */
export async function scheduledHandler() {
  await tick();
  return { ok: true };
}
