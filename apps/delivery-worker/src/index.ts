import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { DeliveryService, type OAuthTokenProvider } from "@pirh/application";
import {
  addTraceAttributes,
  createTelemetryRuntime,
  withExtractedTrace,
} from "@pirh/observability";
import { SafePartnerHttpClient } from "@pirh/partner-http";
import { DynamoPersistence } from "@pirh/persistence";
import {
  createSqsClient,
  ElasticMqQueue,
  parseQueueMessage,
  queueTraceparent,
} from "@pirh/queue";
import {
  LocalDynamoDbSecretStore,
  SsmParameterSecretStore,
} from "@pirh/secrets";

const region = process.env.AWS_REGION ?? "us-east-1";
const local = (process.env.APP_ENV ?? "local") === "local";
const runtime = createTelemetryRuntime({
  service: "delivery-worker",
  environment: process.env.APP_ENV ?? "local",
  otlpEndpoint: process.env.PIRH_OTLP_ENDPOINT,
  logLevel: process.env.LOG_LEVEL,
});
const awsConfig = local
  ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
  : {};
const coreTableName = process.env.CORE_TABLE_NAME ?? "pirh-core-local";
const documentClient = DynamoDBDocumentClient.from(
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
);
export const persistence = new DynamoPersistence(documentClient, {
  coreTableName,
  auditTableName: process.env.AUDIT_TABLE_NAME ?? "pirh-audit-local",
  outboxShardCount: Number(process.env.OUTBOX_SHARD_COUNT ?? 8),
});
const http = new SafePartnerHttpClient({
  mode: local ? "local" : "hosted",
  ...(local
    ? { localHttpHostnames: ["mock-partner-alpha", "mock-partner-beta"] }
    : {}),
});
const cache = new Map<
  string,
  { readonly value: string; readonly expiresAt: number }
>();
const oauth: OAuthTokenProvider = {
  async get(input) {
    const key = `${input.destinationId}\n${input.scopes.join(" ")}`;
    const existing = cache.get(key);
    if (existing !== undefined && existing.expiresAt > Date.now() + 5_000)
      return existing.value;
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    if (input.scopes.length > 0) params.set("scope", input.scopes.join(" "));
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (input.authenticationStyle === "basic")
      headers.authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`;
    else {
      params.set("client_id", input.clientId);
      params.set("client_secret", input.clientSecret);
    }
    const response = await http.send({
      url: input.tokenUrl,
      method: "POST",
      headers,
      body: params.toString(),
      timeoutMs: 5_000,
      correlationId: input.correlationId,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error("OAUTH_TOKEN_ERROR");
    const token = JSON.parse(response.body) as {
      readonly access_token?: unknown;
      readonly expires_in?: unknown;
    };
    if (typeof token.access_token !== "string")
      throw new Error("OAUTH_TOKEN_ERROR");
    const expiresIn =
      typeof token.expires_in === "number" ? token.expires_in : 60;
    cache.set(key, {
      value: token.access_token,
      expiresAt: Date.now() + Math.max(1, expiresIn - 5) * 1_000,
    });
    return token.access_token;
  },
};
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let sequence = 0;
const ids = {
  next(prefix: string) {
    const raw =
      `${Date.now().toString(32).toUpperCase()}${(++sequence).toString(32).toUpperCase()}`
        .padEnd(26, "0")
        .slice(0, 26);
    return `${prefix}_${raw
      .split("")
      .map((value) => (alphabet.includes(value) ? value : "0"))
      .join("")}`;
  },
};
export const deliveryService = new DeliveryService({
  core: persistence,
  repository: persistence,
  secrets: local
    ? new LocalDynamoDbSecretStore(documentClient, {
        coreTableName,
        masterKeyBase64: process.env.LOCAL_SECRET_MASTER_KEY_B64 ?? "",
      })
    : new SsmParameterSecretStore(
        new SSMClient({ region }),
        process.env.SSM_SECRET_PREFIX ?? "/pirh/demo/tenants",
      ),
  http,
  oauth,
  ids: ids as never,
  clock: { now: () => new Date() },
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
  process.env.DELIVERY_QUEUE_NAME ?? "pirh-delivery-local",
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
export async function runLocal(): Promise<void> {
  while (!stopping) {
    try {
      const messages = await queue.receive(
        Number(process.env.DELIVERY_WORKER_CONCURRENCY ?? 5),
        5,
        Number(process.env.DELIVERY_VISIBILITY_TIMEOUT_SECONDS ?? 360),
      );
      const results = await Promise.allSettled(
        messages.map((raw) =>
          withExtractedTrace(
            queueTraceparent(raw),
            "delivery.consume",
            { queue: "delivery" },
            async () => {
              const message = parseQueueMessage(raw);
              if (message.messageType === "DELIVER") {
                addTraceAttributes({
                  correlationId: message.correlationId,
                  eventId: message.eventId,
                  deliveryId: message.deliveryId,
                  tenantId: message.tenantId,
                });
                runtime.telemetry.count("queue.delivery_received");
              }
              if (message.messageType === "RESUME_DESTINATION")
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
              else if (message.messageType === "DELIVER") {
                const outcome = await deliveryService.deliver({
                  ...message,
                  owner: process.env.HOSTNAME ?? "delivery-worker",
                } as never);
                if (!outcome.acknowledge) {
                  await queue.defer(raw, outcome.delaySeconds ?? 5);
                  runtime.logger.info("Delivery deferred", {
                    event: "delivery.deferred",
                    correlationId: message.correlationId,
                    eventId: message.eventId,
                    deliveryId: message.deliveryId,
                    delaySeconds: outcome.delaySeconds ?? 5,
                    tenantId: message.tenantId,
                  });
                  return;
                }
                runtime.logger.info("Delivery completed", {
                  event: "delivery.completed",
                  correlationId: message.correlationId,
                  eventId: message.eventId,
                  deliveryId: message.deliveryId,
                  tenantId: message.tenantId,
                });
              }
              await queue.delete(raw);
            },
          ),
        ),
      );
      for (const result of results)
        if (result.status === "rejected")
          runtime.logger.error("Delivery failed", {
            event: "delivery.failed",
            error: result.reason,
          });
    } catch (error) {
      runtime.logger.error("Delivery failed", {
        event: "delivery.failed",
        error,
      });
    }
  }
  await runtime.shutdown();
}
if (process.argv[1]?.endsWith("index.js")) void runLocal();
export {};
