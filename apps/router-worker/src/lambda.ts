import { queueMessageSchema } from "@pirh/contracts";
import { routerService } from "./index.js";

interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}
interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

/** SQS partial-batch contract: only the named records are retried. */
export async function sqsHandler(event: SqsEvent) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (record) => {
      try {
        const message = queueMessageSchema.parse(JSON.parse(record.body));
        if (message.messageType === "ROUTE_EVENT")
          await routerService.route(message as never);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }),
  );
  return { batchItemFailures };
}
