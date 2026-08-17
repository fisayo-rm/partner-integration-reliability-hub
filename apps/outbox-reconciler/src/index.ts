import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { deliverMessageSchema, routeEventMessageSchema } from "@pirh/contracts";
import { DynamoPersistence } from "@pirh/persistence";
import { createSqsClient, ElasticMqQueue } from "@pirh/queue";

const region = process.env.AWS_REGION ?? "us-east-1";
const credentials = { accessKeyId: "local", secretAccessKey: "local" };
const persistence = new DynamoPersistence(
  DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region,
      endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://dynamodb-local:8000",
      credentials,
    }),
  ),
  {
    coreTableName: process.env.CORE_TABLE_NAME ?? "pirh-core-local",
    auditTableName: process.env.AUDIT_TABLE_NAME ?? "pirh-audit-local",
    outboxShardCount: Number(process.env.OUTBOX_SHARD_COUNT ?? 8),
  },
);
const sqs = createSqsClient({
  region,
  endpoint: process.env.ELASTICMQ_ENDPOINT ?? "http://elasticmq:9324",
  credentials,
});
const routing = new ElasticMqQueue(
  sqs,
  process.env.ROUTING_QUEUE_NAME ?? "pirh-routing-local",
);
const delivery = new ElasticMqQueue(
  sqs,
  process.env.DELIVERY_QUEUE_NAME ?? "pirh-delivery-local",
);
const intervalMs = Number(process.env.OUTBOX_RECONCILE_INTERVAL_MS ?? 5_000);
const staleMs = Number(process.env.OUTBOX_RECONCILE_STALE_MS ?? 60_000);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
async function tick() {
  for (
    let shard = 0;
    shard < Number(process.env.OUTBOX_SHARD_COUNT ?? 8);
    shard += 1
  )
    for (const record of await persistence.getUnpublished(
      shard,
      new Date(Date.now() - staleMs),
      25,
    )) {
      try {
        const message =
          record.kind === "ROUTE_EVENT"
            ? routeEventMessageSchema.parse({
                schemaVersion: 1,
                messageType: "ROUTE_EVENT",
                tenantId: record.tenantId,
                ...record.payload,
              })
            : record.kind === "DELIVER"
              ? deliverMessageSchema.parse({
                  schemaVersion: 1,
                  messageType: "DELIVER",
                  tenantId: record.tenantId,
                  ...record.payload,
                })
              : undefined;
        if (message === undefined) continue;
        await (record.kind === "ROUTE_EVENT" ? routing : delivery).publish({
          body: message as never,
        });
        await persistence.markPublished(record, new Date());
        console.log(
          JSON.stringify({
            service: "outbox-reconciler",
            event: "outbox.republished",
            correlationId: message.correlationId,
            outboxId: record.outboxId,
          }),
        );
      } catch (error) {
        await persistence.recordPublicationFailure(record, new Date());
        console.error(
          JSON.stringify({
            service: "outbox-reconciler",
            event: "outbox.republish_failed",
            outboxId: record.outboxId,
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
}
while (!stopping) {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
export {};
