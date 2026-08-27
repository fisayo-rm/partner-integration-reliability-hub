import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CreateScheduleCommand,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { DynamoPersistence } from "@pirh/persistence";
import { guardLocalProcessStartup } from "@pirh/config";
import {
  createTelemetryRuntime,
  withExtractedTrace,
} from "@pirh/observability";
import {
  createSqsClient,
  ElasticMqQueue,
  outboxQueueMessage,
} from "@pirh/queue";

const region = process.env.AWS_REGION ?? "us-east-1";
const local = (process.env.APP_ENV ?? "local") === "local";
export const runtime = createTelemetryRuntime({
  service: "outbox-worker",
  environment: process.env.APP_ENV ?? "local",
  otlpEndpoint: process.env.PIRH_OTLP_ENDPOINT,
  logLevel: process.env.LOG_LEVEL,
});
const awsConfig = local
  ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
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
const sqs = createSqsClient({
  region,
  ...awsConfig,
  ...(local
    ? { endpoint: process.env.ELASTICMQ_ENDPOINT ?? "http://elasticmq:9324" }
    : {}),
});
const routing = new ElasticMqQueue(
  sqs,
  process.env.ROUTING_QUEUE_NAME ?? "pirh-routing-local",
  process.env.ROUTING_QUEUE_URL,
);
const delivery = new ElasticMqQueue(
  sqs,
  process.env.DELIVERY_QUEUE_NAME ?? "pirh-delivery-local",
  process.env.DELIVERY_QUEUE_URL,
);
const intervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });

const scheduler = local ? undefined : new SchedulerClient({ region });
type OutboxRecord = Parameters<typeof outboxQueueMessage>[0];
async function scheduleLongDelay(
  message: NonNullable<ReturnType<typeof outboxQueueMessage>>,
) {
  const deliveryId = "deliveryId" in message ? message.deliveryId : undefined;
  if (deliveryId === undefined || scheduler === undefined)
    throw new Error("Scheduled delivery configuration is unavailable.");
  const notBefore = new Date(String(message.notBefore));
  const nextAttemptNumber =
    Number(
      (message as unknown as { attemptNumber?: number }).attemptNumber ?? 0,
    ) + 1;
  const targetArn = process.env.DELIVERY_QUEUE_ARN;
  const targetRoleArn = process.env.SCHEDULER_EXECUTION_ROLE_ARN;
  if (targetArn === undefined || targetRoleArn === undefined)
    throw new Error("Scheduler target configuration is unavailable.");
  await scheduler.send(
    new CreateScheduleCommand({
      Name: `${process.env.SCHEDULER_NAME_PREFIX ?? "pirh-demo"}-${deliveryId}-${nextAttemptNumber}`.slice(
        0,
        64,
      ),
      ...(process.env.SCHEDULER_GROUP_NAME === undefined
        ? {}
        : { GroupName: process.env.SCHEDULER_GROUP_NAME }),
      ScheduleExpression: `at(${notBefore.toISOString().replace(/\.\d{3}Z$/, "")})`,
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      ClientToken: `pirh-${deliveryId}-${nextAttemptNumber}`.slice(0, 64),
      Target: {
        Arn: targetArn,
        RoleArn: targetRoleArn,
        Input: JSON.stringify(message),
      },
    }),
  );
}

type OutboxPublisherDependencies = {
  readonly persistence: Pick<
    DynamoPersistence,
    "markPublished" | "recordPublicationFailure" | "materializeScheduledWork"
  >;
  readonly routing: Pick<ElasticMqQueue, "publish">;
  readonly delivery: Pick<ElasticMqQueue, "publish">;
  readonly local: boolean;
  readonly scheduleLongDelay: (
    message: NonNullable<ReturnType<typeof outboxQueueMessage>>,
  ) => Promise<void>;
  readonly now: () => Date;
  readonly telemetry: Pick<typeof runtime.telemetry, "count" | "duration">;
  readonly logger: Pick<typeof runtime.logger, "info" | "error">;
};

/**
 * Import-safe outbox publisher. The queue and persistence boundary is injected
 * so resilience tests can deterministically exercise the send/commit crash
 * window without adding a production fault control.
 */
export function createOutboxPublisher(input: OutboxPublisherDependencies) {
  return async (record: OutboxRecord): Promise<void> =>
    withExtractedTrace(
      record.traceparent,
      "outbox.publish",
      { kind: record.kind },
      async () => {
        try {
          if (record.kind === "SCHEDULE_DELIVERY") {
            const message = outboxQueueMessage(record);
            if (message === undefined) return;
            const delay = Math.max(
              0,
              Math.ceil(
                (new Date(String(record.payload.notBefore)).getTime() -
                  input.now().getTime()) /
                  1_000,
              ),
            );
            if (delay > 900) {
              if (input.local)
                await input.persistence.materializeScheduledWork(record);
              else await input.scheduleLongDelay(message);
            } else
              await input.delivery.publish({
                body: message as never,
                delaySeconds: delay,
                traceparent: record.traceparent,
              });
            await input.persistence.markPublished(record, input.now());
            return;
          }
          const message = outboxQueueMessage(record);
          if (message === undefined) return;
          await (
            record.kind === "ROUTE_EVENT" ? input.routing : input.delivery
          ).publish({
            body: message as never,
            traceparent: record.traceparent,
          });
          await input.persistence.markPublished(record, input.now());
          input.telemetry.count("outbox.published");
          input.telemetry.duration(
            "outbox.age",
            input.now().getTime() - new Date(record.createdAt).getTime(),
          );
          input.logger.info("Outbox published", {
            event: "outbox.published",
            correlationId: message.correlationId,
            eventId: message.eventId,
            deliveryId:
              "deliveryId" in message ? message.deliveryId : undefined,
            tenantId: record.tenantId,
          });
        } catch (error) {
          await input.persistence.recordPublicationFailure(record, input.now());
          input.telemetry.count("outbox.publication_failure");
          input.logger.error("Outbox publication failed", {
            event: "outbox.publish_failed",
            outboxId: record.outboxId,
            tenantId: record.tenantId,
            error,
          });
        }
      },
    );
}

const publisher = createOutboxPublisher({
  persistence,
  routing,
  delivery,
  local,
  scheduleLongDelay,
  now: () => new Date(),
  telemetry: runtime.telemetry,
  logger: runtime.logger,
});
export async function publish(record: OutboxRecord) {
  return publisher(record);
}
export async function tick() {
  for (
    let shard = 0;
    shard < Number(process.env.OUTBOX_SHARD_COUNT ?? 8);
    shard += 1
  )
    for (const record of await persistence.getUnpublished(
      shard,
      new Date(Date.now() + 1),
      25,
    ))
      await publish(record);
}
export async function runLocal(): Promise<void> {
  await guardLocalProcessStartup({
    diagnostics: (result) =>
      runtime.logger.info("Hybrid environment attested", {
        event: "hybrid.attestation",
        ...result,
      }),
  });
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await runtime.shutdown();
}
if (process.argv[1]?.endsWith("index.js")) void runLocal();
export {};
