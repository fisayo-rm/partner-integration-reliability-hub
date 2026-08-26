import { runtime, tick } from "./index.js";

interface StreamRecord {
  readonly eventID: string;
}
interface StreamEvent {
  readonly Records: readonly StreamRecord[];
}

/** The core table stream is an acceleration signal; tick performs idempotent outbox claiming. */
export function createStreamHandler(input: {
  readonly tick: () => Promise<void>;
  readonly flush: () => Promise<void>;
}) {
  return async (event: StreamEvent) => {
    try {
      await input.tick();
      await input.flush();
      return { batchItemFailures: [] as { itemIdentifier: string }[] };
    } catch {
      await input.flush();
      return {
        batchItemFailures: event.Records.map((record) => ({
          itemIdentifier: record.eventID,
        })),
      };
    }
  };
}
export const streamHandler = createStreamHandler({
  tick,
  flush: () => runtime.flush(),
});
