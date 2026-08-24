import { queueMessageSchema } from "@pirh/contracts";
import { deliveryService, persistence } from "./index.js";

interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}
interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

export async function sqsHandler(event: SqsEvent) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (record) => {
      try {
        const message = queueMessageSchema.parse(JSON.parse(record.body));
        if (message.messageType === "DELIVER") {
          const outcome = await deliveryService.deliver({
            ...message,
            owner: process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? "delivery-worker",
          } as never);
          // A Lambda SQS consumer cannot safely defer a received record. Throwing
          // returns only this record to SQS and preserves the delivery lease.
          if (!outcome.acknowledge) throw new Error("DELIVERY_NOT_BEFORE");
        } else if (message.messageType === "RESUME_DESTINATION")
          await persistence.resumeDestination({
            context: {
              tenantId: message.tenantId as never,
              actorType: "system",
              actorId: "delivery-worker",
              requestId: "resume-destination",
              correlationId: message.correlationId as never,
            },
            destinationId: message.destinationId as never,
            now: new Date(),
          });
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }),
  );
  return { batchItemFailures };
}
