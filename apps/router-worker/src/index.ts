import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { RoutingService } from "@pirh/application";
import { DynamoPersistence } from "@pirh/persistence";
import { consumeOne, createSqsClient, ElasticMqQueue } from "@pirh/queue";
import { executeTransformation } from "@pirh/transformation";

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
let sequence = 0;
const ids = {
  next: (prefix: string) =>
    `${prefix}_${`${Date.now().toString(32).toUpperCase()}${(++sequence).toString(32).toUpperCase()}`.padEnd(26, "0").slice(0, 26)}`,
};
const service = new RoutingService({
  core: persistence,
  repository: persistence,
  execute: executeTransformation,
  ids: ids as never,
  clock: { now: () => new Date() },
  retentionDays: Number(process.env.EVENT_RETENTION_DAYS ?? 30),
});
const queue = new ElasticMqQueue(
  createSqsClient({
    region,
    endpoint: process.env.ELASTICMQ_ENDPOINT ?? "http://elasticmq:9324",
    credentials,
  }),
  process.env.ROUTING_QUEUE_NAME ?? "pirh-routing-local",
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    await consumeOne(queue, async (message) => {
      if (message.messageType !== "ROUTE_EVENT") return;
      await service.route(message as never);
      console.log(
        JSON.stringify({
          service: "router-worker",
          event: "routing.completed",
          correlationId: message.correlationId,
          eventId: message.eventId,
        }),
      );
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        service: "router-worker",
        event: "routing.failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}
export {};
