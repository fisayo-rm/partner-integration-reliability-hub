import { buildApi, type HealthProbe } from "./app.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ConsoleAuthenticator,
  OidcAccessTokenVerifier,
  ProducerAuthenticator,
} from "@pirh/auth";
import { ControlPlaneService, EventIngestionService } from "@pirh/application";
import { DynamoPersistence } from "@pirh/persistence";
import { LocalDynamoDbSecretStore } from "@pirh/secrets";
import { SafePartnerHttpClient } from "@pirh/partner-http";
import { executeTransformation } from "@pirh/transformation";

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const timeoutMs = 1_000;
function httpProbe(name: string, url: string): HealthProbe {
  return async () => {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        name,
        ok: response.status < 500,
        detail: `HTTP ${response.status}`,
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
      process.env.ELASTICMQ_ENDPOINT,
  ),
  detail: "APP_ENV, DYNAMODB_ENDPOINT, and ELASTICMQ_ENDPOINT are required",
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
const app = await buildApi({
  requiredConfiguration,
  dynamoDb: httpProbe(
    "dynamodb",
    process.env.DYNAMODB_ENDPOINT ?? "http://dynamodb-local:8000",
  ),
  elasticMq: httpProbe(
    "elasticmq",
    process.env.ELASTICMQ_ENDPOINT ?? "http://elasticmq:9324",
  ),
  controlPlane: {
    service,
    repository: persistence,
    consoleAuthenticator: new ConsoleAuthenticator(
      new OidcAccessTokenVerifier({
        issuer:
          process.env.OIDC_ISSUER ?? "http://keycloak:8080/realms/pirh-local",
        audience: process.env.OIDC_AUDIENCE ?? "pirh-console",
        jwksUri:
          process.env.OIDC_JWKS_URI ??
          "http://keycloak:8080/realms/pirh-local/protocol/openid-connect/certs",
        allowedAlgorithms: ["RS256"],
        tokenUseClaim: "typ",
        tokenUseValue: "Bearer",
      }),
      persistence,
    ),
    cursorSecret:
      process.env.LOCAL_CURSOR_SECRET ??
      "local-cursor-secret-not-for-production",
  },
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
    }),
    repository: persistence,
    producerAuthenticator: new ProducerAuthenticator(
      persistence,
      secrets,
      persistence,
    ),
  },
  requestId: () => id("req"),
});
await app.listen({ host, port });
