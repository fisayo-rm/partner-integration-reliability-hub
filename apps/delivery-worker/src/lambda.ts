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

export function createSqsHandler(input: {
  readonly deliver: (
    message: unknown,
  ) => Promise<{ readonly acknowledge: boolean }>;
  readonly resume: (message: {
    readonly tenantId: string;
    readonly destinationId: string;
    readonly correlationId: string;
  }) => Promise<unknown>;
  readonly flush: () => Promise<void>;
}) {
  return async (event: SqsEvent) => {
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
                const outcome = await input.deliver(message);
                if (!outcome.acknowledge)
                  throw new Error("DELIVERY_NOT_BEFORE");
              } else if (message.messageType === "RESUME_DESTINATION")
                await input.resume(message);
            },
          );
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }),
    );
    await input.flush();
    return { batchItemFailures };
  };
}
export const sqsHandler = createSqsHandler({
  deliver: (message) =>
    deliveryService.deliver({
      ...(message as object),
      owner: process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? "delivery-worker",
    } as never),
  resume: (message) =>
    persistence.resumeDestination({
      context: {
        tenantId: message.tenantId as never,
        actorType: "system",
        actorId: "delivery-worker",
        requestId: "resume-destination",
        correlationId: message.correlationId as never,
      },
      destinationId: message.destinationId as never,
      now: new Date(),
    }),
  flush: () => runtime.flush(),
});
