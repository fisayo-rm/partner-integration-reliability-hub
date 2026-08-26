import { runtime, tick } from "./index.js";

/** EventBridge schedule target. Reconciliation is idempotent by outbox state. */
export async function scheduledHandler() {
  try {
    await tick();
    return { ok: true };
  } finally {
    await runtime.flush();
  }
}
