import { queueMessageSchema } from "@pirh/contracts";
import { addTraceAttributes, withExtractedTrace } from "@pirh/observability";
import { deliveryService, persistence, runtime } from "./index.js";

interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
  readonly messageAttributes?: Readonly<
    Record<string, { readonly stringValue?: string | undefined }>
  >;
}
interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

export async function sqsHandler(event: SqsEvent) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (record) => {
      try {
        await withExtractedTrace(
          record.messageAttributes?.traceparent?.stringValue,
          "delivery.consume",
          { queue: "delivery" },
          async () => {
            const message = queueMessageSchema.parse(JSON.parse(record.body));
            if (message.messageType === "DELIVER") {
              addTraceAttributes({
                correlationId: message.correlationId,
                eventId: message.eventId,
                deliveryId: message.deliveryId,
                tenantId: message.tenantId,
              });
              const outcome = await deliveryService.deliver({
                ...message,
                owner:
                  process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? "delivery-worker",
              } as never);
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
          },
        );
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }),
  );
  await runtime.flush();
  return { batchItemFailures };
}
