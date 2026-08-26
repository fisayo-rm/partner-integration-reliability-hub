import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { RoutingService } from "@pirh/application";
import { guardLocalProcessStartup } from "@pirh/config";
import {
  createTelemetryRuntime,
  withExtractedTrace,
} from "@pirh/observability";
import { DynamoPersistence } from "@pirh/persistence";
import {
  consumeOne,
  createSqsClient,
  ElasticMqQueue,
  queueTraceparent,
} from "@pirh/queue";
import { executeTransformation } from "@pirh/transformation";

const region = process.env.AWS_REGION ?? "us-east-1";
const local = (process.env.APP_ENV ?? "local") === "local";
const runtime = createTelemetryRuntime({
  service: "router-worker",
  environment: process.env.APP_ENV ?? "local",
  otlpEndpoint: process.env.PIRH_OTLP_ENDPOINT,
  logLevel: process.env.LOG_LEVEL,
});
const awsConfig = local
  ? {
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }
  : {};
const persistence = new DynamoPersistence(
  DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region,
      ...awsConfig,
      ...(local
        ? {
            endpoint:
              process.env.DYNAMODB_ENDPOINT ?? "http://dynamodb-local:8000",
          }
        : {}),
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
export const routerService = new RoutingService({
  core: persistence,
  repository: persistence,
  execute: executeTransformation,
  ids: ids as never,
  clock: { now: () => new Date() },
  retentionDays: Number(process.env.EVENT_RETENTION_DAYS ?? 30),
  telemetry: runtime.telemetry,
});
const queue = new ElasticMqQueue(
  createSqsClient({
    region,
    ...awsConfig,
    ...(local
      ? { endpoint: process.env.ELASTICMQ_ENDPOINT ?? "http://elasticmq:9324" }
      : {}),
  }),
  process.env.ROUTING_QUEUE_NAME ?? "pirh-routing-local",
  process.env.ROUTING_QUEUE_URL,
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
export async function runLocal(): Promise<void> {
  await guardLocalProcessStartup({
    diagnostics: (result) =>
      runtime.logger.info("Hybrid environment attested", {
        event: "hybrid.attestation",
        ...result,
      }),
  });
  while (!stopping) {
    try {
      await consumeOne(queue, async (message, raw) => {
        if (message.messageType !== "ROUTE_EVENT") return;
        await withExtractedTrace(
          queueTraceparent(raw),
          "routing.consume",
          {
            messageType: message.messageType,
            correlationId: message.correlationId,
            eventId: message.eventId,
            tenantId: message.tenantId,
          },
          async () => {
            await routerService.route(message as never);
            runtime.logger.info("Routing completed", {
              event: "routing.completed",
              correlationId: message.correlationId,
              eventId: message.eventId,
              tenantId: message.tenantId,
            });
          },
        );
      });
    } catch (error) {
      runtime.logger.error("Routing failed", {
        event: "routing.failed",
        error,
      });
    }
  }
  await runtime.shutdown();
}
if (process.argv[1]?.endsWith("index.js")) void runLocal();
export {};
