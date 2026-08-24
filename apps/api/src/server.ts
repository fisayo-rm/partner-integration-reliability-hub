import { buildApi, type HealthProbe } from "./app.js";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  ConsoleAuthenticator,
  OidcAccessTokenVerifier,
  ProducerAuthenticator,
} from "@pirh/auth";
import {
  ControlPlaneService,
  EventIngestionService,
  ReplayService,
} from "@pirh/application";
import { DynamoPersistence } from "@pirh/persistence";
import { LocalDynamoDbSecretStore } from "@pirh/secrets";
import { SafePartnerHttpClient } from "@pirh/partner-http";
import { executeTransformation } from "@pirh/transformation";
import { ConfigurationPortabilityService } from "@pirh/config-portability";
import { createTelemetryRuntime } from "@pirh/observability";

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const timeoutMs = 1_000;
const runtime = createTelemetryRuntime({
  service: "api",
  environment: process.env.APP_ENV ?? "local",
  otlpEndpoint: process.env.PIRH_OTLP_ENDPOINT,
  logLevel: process.env.LOG_LEVEL,
});
function boundedProbe(name: string, action: () => Promise<void>): HealthProbe {
  return async () => {
    try {
      await action();
      return {
        name,
        ok: true,
      };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.message : "probe failed",
      };
    }
  };
}
const requiredConfiguration: HealthProbe = async () => ({
  name: "configuration",
  ok: Boolean(
    process.env.APP_ENV &&
      process.env.DYNAMODB_ENDPOINT &&
      process.env.ELASTICMQ_ENDPOINT &&
      process.env.PORTABILITY_PLAN_SIGNING_KEY_B64,
  ),
  detail:
    "APP_ENV, DYNAMODB_ENDPOINT, ELASTICMQ_ENDPOINT, and PORTABILITY_PLAN_SIGNING_KEY_B64 are required",
});
const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.DYNAMODB_ENDPOINT === undefined
      ? {}
      : { endpoint: process.env.DYNAMODB_ENDPOINT }),
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);
const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  ...(process.env.DYNAMODB_ENDPOINT === undefined
    ? {}
    : { endpoint: process.env.DYNAMODB_ENDPOINT }),
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const sqsClient = new SQSClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  ...(process.env.ELASTICMQ_ENDPOINT === undefined
    ? {}
    : { endpoint: process.env.ELASTICMQ_ENDPOINT }),
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const persistence = new DynamoPersistence(documentClient, {
  coreTableName: process.env.CORE_TABLE_NAME ?? "pirh-core-local",
  auditTableName: process.env.AUDIT_TABLE_NAME ?? "pirh-audit-local",
  outboxShardCount: 8,
});
const masterKey = process.env.LOCAL_SECRET_MASTER_KEY_B64 ?? "";
const secrets = new LocalDynamoDbSecretStore(documentClient, {
  coreTableName: process.env.CORE_TABLE_NAME ?? "pirh-core-local",
  masterKeyBase64: masterKey,
});
let sequence = 0;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function id(prefix: string): string {
  const value =
    `${Date.now().toString(32).toUpperCase()}${(++sequence).toString(32).toUpperCase()}`
      .padEnd(26, "0")
      .slice(0, 26)
      .split("")
      .map((char) => (alphabet.includes(char) ? char : "0"))
      .join("");
  return `${prefix}_${value}`;
}
const service = new ControlPlaneService({
  repository: persistence,
  audit: persistence,
  secrets,
  endpoints: new SafePartnerHttpClient({
    mode: "local",
    localHttpHostnames: ["mock-partner-alpha", "mock-partner-beta"],
  }),
  execute: executeTransformation,
  ids: { next: (prefix) => id(prefix) },
  clock: { now: () => new Date() },
});
const portability = new ConfigurationPortabilityService({
  repository: persistence,
  service,
  secrets,
  audit: persistence,
  ids: { next: (prefix) => id(prefix) },
  sourceEnvironment: process.env.APP_ENV ?? "local",
  planSigningKeyBase64: process.env.PORTABILITY_PLAN_SIGNING_KEY_B64 ?? "",
});
const consoleAuthenticator = new ConsoleAuthenticator(
  new OidcAccessTokenVerifier({
    issuer: process.env.OIDC_ISSUER ?? "http://keycloak:8080/realms/pirh-local",
    audience: process.env.OIDC_AUDIENCE ?? "pirh-console",
    jwksUri:
      process.env.OIDC_JWKS_URI ??
      "http://keycloak:8080/realms/pirh-local/protocol/openid-connect/certs",
    allowedAlgorithms: ["RS256"],
    tokenUseClaim: "typ",
    tokenUseValue: "Bearer",
  }),
  persistence,
);
const app = await buildApi({
  requiredConfiguration,
  dynamoDb: boundedProbe("dynamodb", async () => {
    for (const TableName of [
      process.env.CORE_TABLE_NAME ?? "pirh-core-local",
      process.env.AUDIT_TABLE_NAME ?? "pirh-audit-local",
    ])
      await dynamoClient.send(new DescribeTableCommand({ TableName }), {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
  }),
  elasticMq: boundedProbe("queues", async () => {
    for (const QueueName of [
      process.env.ROUTING_QUEUE_NAME ?? "pirh-routing-local",
      process.env.DELIVERY_QUEUE_NAME ?? "pirh-delivery-local",
    ])
      await sqsClient.send(new GetQueueUrlCommand({ QueueName }), {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
  }),
  controlPlane: {
    service,
    repository: persistence,
    consoleAuthenticator,
    cursorSecret:
      process.env.LOCAL_CURSOR_SECRET ??
      "local-cursor-secret-not-for-production",
  },
  portability: { service: portability },
  eventIngestion: {
    service: new EventIngestionService({
      writer: persistence,
      ids: { next: (prefix) => id(prefix) },
      clock: { now: () => new Date() },
      supportedEventTypes: new Set(
        (process.env.SUPPORTED_EVENT_TYPES ?? "shipment.status_changed")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
      eventRetentionDays: Number(process.env.EVENT_RETENTION_DAYS ?? 30),
      telemetry: runtime.telemetry,
    }),
    repository: persistence,
    producerAuthenticator: new ProducerAuthenticator(
      persistence,
      secrets,
      persistence,
    ),
  },
  operations: {
    service: new ReplayService({
      core: persistence,
      repository: persistence,
      execute: executeTransformation,
      ids: { next: (prefix) => id(prefix) },
      clock: { now: () => new Date() },
      retentionDays: Number(process.env.EVENT_RETENTION_DAYS ?? 30),
      telemetry: runtime.telemetry,
    }),
    repository: persistence,
    consoleAuthenticator,
    cursorSecret:
      process.env.LOCAL_CURSOR_SECRET ??
      "local-cursor-secret-not-for-production",
  },
  requestId: () => id("req"),
  logger: runtime.logger,
  telemetry: runtime.telemetry,
  consoleOrigins: (process.env.CONSOLE_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close());
app.addHook("onClose", async () => runtime.shutdown());
await app.listen({ host, port });
