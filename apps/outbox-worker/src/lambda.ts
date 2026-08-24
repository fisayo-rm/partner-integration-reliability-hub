import { tick } from "./index.js";

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
    return { batchItemFailures: [] as { itemIdentifier: string }[] };
  } catch {
    return {
      batchItemFailures: event.Records.map((record) => ({
        itemIdentifier: record.eventID,
      })),
    };
  }
}
