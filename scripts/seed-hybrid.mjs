import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ControlPlaneService } from "@pirh/application";
import { guardLocalProcessStartup } from "@pirh/config";
import { SafePartnerHttpClient } from "@pirh/partner-http";
import { DynamoPersistence, key } from "@pirh/persistence";
import { SsmParameterSecretStore } from "@pirh/secrets";
import { executeTransformation } from "@pirh/transformation";

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} is required.`);
  return value;
};
await guardLocalProcessStartup({
  diagnostics: (result) =>
    console.info(JSON.stringify({ event: "hybrid.attestation", ...result })),
});

const region = required("AWS_REGION");
const coreTableName = required("CORE_TABLE_NAME");
const auditTableName = required("AUDIT_TABLE_NAME");
const ssmNamespace = required("SSM_NAMESPACE");
const ssmSecretPrefix = required("SSM_SECRET_PREFIX");
const alphaUrl = required("HYBRID_MOCK_ALPHA_URL");
const producerSecret = required("PIRH_HYBRID_SMOKE_PRODUCER_SECRET");
const alphaApiKey = required("PIRH_HYBRID_SMOKE_ALPHA_API_KEY");
const controlToken = required("PIRH_HYBRID_SMOKE_CONTROL_TOKEN");
const identifierAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const raw = Array.from(
  randomBytes(26),
  (value) => identifierAlphabet[value % identifierAlphabet.length],
).join("");
const tenantId = `tenant_${raw}`;
const clientId = `cli_${raw}`;
const now = new Date().toISOString();
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const ssm = new SSMClient({ region });

async function secureParameter(name, value) {
  const response = await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: "SecureString",
      Overwrite: true,
    }),
  );
  if (response.Version === undefined)
    throw new Error(`Parameter ${name} version is unavailable.`);
  return String(response.Version);
}

const [producerVersion] = await Promise.all([
  secureParameter(
    `${ssmSecretPrefix}/${tenantId}/secrets/producer-current`,
    producerSecret,
  ),
  secureParameter(
    `${ssmNamespace}/system/cursor-secret`,
    randomBytes(32).toString("base64url"),
  ),
  secureParameter(
    `${ssmNamespace}/system/portability-plan-signing-key`,
    randomBytes(32).toString("base64"),
  ),
  secureParameter(`${ssmNamespace}/system/mock-control-token`, controlToken),
  secureParameter(`${ssmNamespace}/mock/alpha/api-key`, alphaApiKey),
]);

const persistence = new DynamoPersistence(ddb, {
  coreTableName,
  auditTableName,
  outboxShardCount: 8,
});
const context = {
  tenantId,
  actorType: "system",
  actorId: "hybrid-smoke-seeder",
  requestId: `seed_${raw}`,
  correlationId: `cor_${raw}`,
};
await persistence.putSeed([
  {
    ...key.tenant(tenantId),
    entityType: "TENANT",
    tenantId,
    externalKey: `hybrid-smoke-${raw}`,
    name: "Hybrid smoke tenant",
    status: "active",
    createdAt: now,
    version: 1,
  },
  {
    ...key.apiClient(tenantId, clientId),
    entityType: "API_CLIENT",
    clientId,
    tenantId,
    name: "hybrid-smoke-producer",
    status: "active",
    scopes: ["events:submit", "events:read"],
    secretVersions: [
      {
        reference: { name: "producer-current", version: producerVersion },
        state: "active",
        activatedAt: now,
      },
    ],
    createdAt: now,
    version: 1,
  },
  {
    ...key.apiClientLocator(clientId),
    entityType: "API_CLIENT_LOCATOR",
    clientId,
    tenantId,
    createdAt: now,
  },
]);

let sequence = 0;
const ids = {
  next(prefix) {
    sequence += 1;
    return `${prefix}_${raw.slice(0, 22)}${String(sequence).padStart(4, "0")}`;
  },
};
const service = new ControlPlaneService({
  repository: persistence,
  audit: persistence,
  secrets: new SsmParameterSecretStore(ssm, ssmSecretPrefix),
  endpoints: new SafePartnerHttpClient({ mode: "hosted" }),
  execute: executeTransformation,
  ids,
  clock: { now: () => new Date() },
});
const partner = await service.createPartner(context, {
  name: "Hybrid smoke Alpha",
  externalKey: `hybrid-alpha-${raw}`,
  enabled: true,
});
const transformation = await service.createTransformation(context, {
  externalKey: `hybrid-transformation-${raw}`,
  definition: {
    schemaVersion: 1,
    contentType: "application/json",
    mappings: [
      {
        target: "$.tracking_number",
        source: "$.data.trackingNumber",
        required: true,
      },
      {
        target: "$.delivery_status",
        source: "$.data.status",
        required: true,
      },
      { target: "$.event_reference", source: "$.eventId", required: true },
    ],
  },
});
const destination = await service.createDestination(context, {
  partnerId: partner.partnerId,
  name: "Hybrid Alpha deliveries",
  externalKey: `hybrid-alpha-deliveries-${raw}`,
  baseUrl: alphaUrl,
  path: "/webhooks/shipments",
  method: "POST",
  enabled: true,
  authType: "api_key",
  authConfiguration: {
    headerName: "X-API-Key",
    idempotencyHeader: "Idempotency-Key",
  },
  timeoutMs: 8_000,
  retryPolicy: {
    maxAttempts: 3,
    initialDelaySeconds: 1,
    multiplier: 2,
    maxDelaySeconds: 30,
    jitter: "FULL_UPPER_HALF",
  },
  rateLimitPolicy: {
    requestsPerInterval: 20,
    intervalSeconds: 1,
    burstCapacity: 20,
    safetyFactor: 1,
  },
  circuitBreakerPolicy: {
    failureThreshold: 3,
    cooldownSeconds: 10,
    probeLeaseSeconds: 5,
  },
  transformationId: transformation.transformationId,
  activeTransformationVersion: 1,
  sensitiveResponseJsonPaths: [],
  credential: { alias: "alpha-api-key", value: alphaApiKey },
});
await service.createSubscription(context, {
  externalKey: `hybrid-subscription-${raw}`,
  destinationId: destination.destinationId,
  eventType: "shipment.status_changed",
  enabled: true,
});
await ddb.send(
  new PutCommand({
    TableName: coreTableName,
    Item: {
      ...key.identity("hybrid-smoke", `seed-${raw}`),
      entityType: "USER_IDENTITY",
      issuer: "hybrid-smoke",
      subject: `seed-${raw}`,
      tenantId,
      userId: "hybrid-smoke",
      role: "admin",
      status: "active",
      createdAt: now,
    },
  }),
);
console.log(
  JSON.stringify({
    tenantId,
    clientId,
    destinationId: destination.destinationId,
  }),
);
