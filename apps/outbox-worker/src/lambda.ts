import { runtime, tick } from "./index.js";

interface StreamRecord {
  readonly eventID: string;
}
interface StreamEvent {
  readonly Records: readonly StreamRecord[];
}

/** The core table stream is an acceleration signal; tick performs idempotent outbox claiming. */
export async function streamHandler(event: StreamEvent) {
  try {
    await tick();
    await runtime.flush();
    return { batchItemFailures: [] as { itemIdentifier: string }[] };
  } catch {
    await runtime.flush();
    return {
      batchItemFailures: event.Records.map((record) => ({
        itemIdentifier: record.eventID,
      })),
    };
  }
}
