import { queueMessageSchema } from "@pirh/contracts";
import { withExtractedTrace } from "@pirh/observability";
import { routerService, runtime } from "./index.js";

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

/** SQS partial-batch contract: only the named records are retried. */
export function createSqsHandler(input: {
  readonly route: (message: unknown) => Promise<unknown>;
  readonly flush: () => Promise<void>;
}) {
  return async (event: SqsEvent) => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    await Promise.all(
      event.Records.map(async (record) => {
        try {
          await withExtractedTrace(
            record.messageAttributes?.traceparent?.stringValue,
            "routing.consume",
            { queue: "routing" },
            async () => {
              const message = queueMessageSchema.parse(JSON.parse(record.body));
              if (message.messageType === "ROUTE_EVENT")
                await input.route(message);
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
  route: (message) => routerService.route(message as never),
  flush: () => runtime.flush(),
});
