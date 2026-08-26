import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ConfigurationPortabilityService } from "@pirh/config-portability";
import { guardLocalProcessStartup } from "@pirh/config";
import {
  ControlPlaneService,
  EventIngestionService,
  ReplayService,
} from "@pirh/application";
import {
  ConsoleAuthenticator,
  OidcAccessTokenVerifier,
  ProducerAuthenticator,
} from "@pirh/auth";
import { createTelemetryRuntime } from "@pirh/observability";
import { SafePartnerHttpClient } from "@pirh/partner-http";
import { DynamoPersistence } from "@pirh/persistence";
import {
  LocalDynamoDbSecretStore,
  SsmParameterSecretStore,
} from "@pirh/secrets";
import { executeTransformation } from "@pirh/transformation";
import type { ApiDependencies, HealthProbe } from "./app.js";

const region = process.env.AWS_REGION ?? "us-east-1";
const environment = process.env.APP_ENV ?? "local";
const local = environment === "local";

function awsConfig(endpoint: string | undefined) {
  return local && endpoint !== undefined
    ? {
        endpoint,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : local
      ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
      : {};
}
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required.`);
  return value;
}
function boundedProbe(name: string, action: () => Promise<void>): HealthProbe {
  return async () => {
    try {
      await action();
      return { name, ok: true };
    } catch {
      return { name, ok: false };
    }
  };
}
function idGenerator() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let sequence = 0;
  return {
    next(prefix: string): string {
      const raw =
        `${Date.now().toString(32).toUpperCase()}${(++sequence).toString(32).toUpperCase()}`
          .padEnd(26, "0")
          .slice(0, 26)
          .split("")
          .map((value) => (alphabet.includes(value) ? value : "0"))
          .join("");
      return `${prefix}_${raw}`;
    },
  };
}
async function parameter(client: SSMClient, name: string): Promise<string> {
  const result = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  if (result.Parameter?.Value === undefined)
    throw new Error(`Parameter ${name} could not be resolved.`);
  return result.Parameter.Value;
}

/** Creates one dependency graph per Lambda execution environment. */
export async function createApiDependencies(
  input: {
    readonly localProcess?: boolean;
  } = {},
): Promise<{
  readonly dependencies: ApiDependencies;
  readonly shutdown: () => Promise<void>;
}> {
  if (input.localProcess === true)
    await guardLocalProcessStartup({
      diagnostics: (result) =>
        console.info(
          JSON.stringify({ event: "hybrid.attestation", ...result }),
        ),
    });
  const dynamoEndpoint = local ? required("DYNAMODB_ENDPOINT") : undefined;
  const queueEndpoint = local ? required("ELASTICMQ_ENDPOINT") : undefined;
  const coreTableName = process.env.CORE_TABLE_NAME ?? "pirh-core-local";
  const auditTableName = process.env.AUDIT_TABLE_NAME ?? "pirh-audit-local";
  const routingQueueName =
    process.env.ROUTING_QUEUE_NAME ?? "pirh-routing-local";
  const routingQueueUrl = process.env.ROUTING_QUEUE_URL;
  const deliveryQueueName =
    process.env.DELIVERY_QUEUE_NAME ?? "pirh-delivery-local";
  const deliveryQueueUrl = process.env.DELIVERY_QUEUE_URL;
  const documentClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region, ...awsConfig(dynamoEndpoint) }),
  );
  const dynamoClient = new DynamoDBClient({
    region,
    ...awsConfig(dynamoEndpoint),
  });
  const sqsClient = new SQSClient({ region, ...awsConfig(queueEndpoint) });
  const ssmClient = new SSMClient({ region });
  const persistence = new DynamoPersistence(documentClient, {
    coreTableName,
    auditTableName,
    outboxShardCount: Number(process.env.OUTBOX_SHARD_COUNT ?? 8),
  });
  const secrets = local
    ? new LocalDynamoDbSecretStore(documentClient, {
        coreTableName,
        masterKeyBase64: required("LOCAL_SECRET_MASTER_KEY_B64"),
      })
    : new SsmParameterSecretStore(ssmClient, required("SSM_SECRET_PREFIX"));
  const [cursorSecret, planSigningKeyBase64] = local
    ? [
        process.env.LOCAL_CURSOR_SECRET ??
          "local-cursor-secret-not-for-production",
        required("PORTABILITY_PLAN_SIGNING_KEY_B64"),
      ]
    : await Promise.all([
        parameter(ssmClient, required("CURSOR_SECRET_PARAMETER")),
        parameter(
          ssmClient,
          required("PORTABILITY_PLAN_SIGNING_KEY_PARAMETER"),
        ),
      ]);
  const runtime = createTelemetryRuntime({
    service: "api",
    environment,
    otlpEndpoint: process.env.PIRH_OTLP_ENDPOINT,
    logLevel: process.env.LOG_LEVEL,
  });
  const ids = idGenerator();
  const service = new ControlPlaneService({
    repository: persistence,
    audit: persistence,
    secrets,
    endpoints: new SafePartnerHttpClient({
      mode: local ? "local" : "hosted",
      ...(local
        ? { localHttpHostnames: ["mock-partner-alpha", "mock-partner-beta"] }
        : {}),
    }),
    execute: executeTransformation,
    ids,
    clock: { now: () => new Date() },
  });
  const tokenUse = local
    ? { tokenUseClaim: "typ", tokenUseValue: "Bearer", roleClaim: "roles" }
    : {
        tokenUseClaim: "token_use",
        tokenUseValue: "access",
        roleClaim: "cognito:groups",
        audienceClaim: "client_id",
      };
  const consoleAuthenticator = new ConsoleAuthenticator(
    new OidcAccessTokenVerifier({
      issuer: required("OIDC_ISSUER"),
      audience: required("OIDC_AUDIENCE"),
      jwksUri: required("OIDC_JWKS_URI"),
      allowedAlgorithms: ["RS256"],
      ...tokenUse,
    }),
    persistence,
  );
  return {
    dependencies: {
      requiredConfiguration: async () => ({ name: "configuration", ok: true }),
      dynamoDb: boundedProbe("dynamodb", async () => {
        for (const TableName of [coreTableName, auditTableName])
          await dynamoClient.send(new DescribeTableCommand({ TableName }), {
            abortSignal: AbortSignal.timeout(1_000),
          });
      }),
      elasticMq: boundedProbe("queues", async () => {
        for (const [QueueName, QueueUrl] of [
          [routingQueueName, routingQueueUrl],
          [deliveryQueueName, deliveryQueueUrl],
        ] as const) {
          if (QueueUrl === undefined)
            await sqsClient.send(new GetQueueUrlCommand({ QueueName }), {
              abortSignal: AbortSignal.timeout(1_000),
            });
          else
            await sqsClient.send(new GetQueueAttributesCommand({ QueueUrl }), {
              abortSignal: AbortSignal.timeout(1_000),
            });
        }
      }),
      controlPlane: {
        service,
        repository: persistence,
        consoleAuthenticator,
        cursorSecret,
      },
      portability: {
        service: new ConfigurationPortabilityService({
          repository: persistence,
          service,
          secrets,
          audit: persistence,
          ids,
          sourceEnvironment: environment,
          planSigningKeyBase64,
        }),
      },
      eventIngestion: {
        service: new EventIngestionService({
          writer: persistence,
          ids,
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
          ids,
          clock: { now: () => new Date() },
          retentionDays: Number(process.env.EVENT_RETENTION_DAYS ?? 30),
          telemetry: runtime.telemetry,
        }),
        repository: persistence,
        consoleAuthenticator,
        cursorSecret,
      },
      requestId: () => ids.next("req"),
      logger: runtime.logger,
      telemetry: runtime.telemetry,
      consoleOrigins: (process.env.CONSOLE_ORIGIN ?? "http://localhost:5173")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    },
    shutdown: () => runtime.shutdown(),
  };
}
