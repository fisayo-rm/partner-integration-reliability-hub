import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LocalDynamoDbSecretStore } from "@pirh/secrets";
import { DynamoPersistence, key } from "@pirh/persistence";
import { ControlPlaneService } from "@pirh/application";
import { SafePartnerHttpClient } from "@pirh/partner-http";
import { executeTransformation } from "@pirh/transformation";
import type { ClientId, TenantContext } from "@pirh/domain";

const tenantId =
  "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as TenantContext["tenantId"];
const clientId = "cli_01J0A1B2C3D4E5F6G7H8J9K0MN" as ClientId;
const issuer =
  process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/pirh-local";
const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://dynamodb-local:8000";
const coreTableName = process.env.CORE_TABLE_NAME ?? "pirh-core-local";
const auditTableName = process.env.AUDIT_TABLE_NAME ?? "pirh-audit-local";
const masterKey = process.env.LOCAL_SECRET_MASTER_KEY_B64;
const producerSecret = process.env.LOCAL_SEED_PRODUCER_SECRET;
const alphaKey = process.env.LOCAL_SEED_ALPHA_API_KEY;
const betaSecret = process.env.LOCAL_SEED_BETA_CLIENT_SECRET;
if (
  masterKey === undefined ||
  producerSecret === undefined ||
  alphaKey === undefined ||
  betaSecret === undefined
)
  throw new Error("Local secret seed configuration is required.");
const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);
const persistence = new DynamoPersistence(documentClient, {
  coreTableName,
  auditTableName,
  outboxShardCount: 8,
});
const seedContext: TenantContext = {
  tenantId,
  actorType: "system",
  actorId: "local-seeder",
  requestId: "seed",
  correlationId:
    "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as TenantContext["correlationId"],
};
const store = new LocalDynamoDbSecretStore(documentClient, {
  coreTableName,
  masterKeyBase64: masterKey,
});
const reference = { name: "producer-demo", version: "seed-v1" };
const identities: readonly (readonly [string, string, string])[] = [
  ["11111111-1111-4111-8111-111111111111", "admin", "local-admin"],
  ["22222222-2222-4222-8222-222222222222", "operator", "local-operator"],
  ["33333333-3333-4333-8333-333333333333", "viewer", "local-viewer"],
];
try {
  await store.resolve(seedContext, reference);
} catch {
  await store.store(seedContext, {
    name: reference.name,
    version: reference.version,
    value: producerSecret,
  });
}
const now = new Date().toISOString();
await persistence.putSeed([
  {
    ...key.tenant(tenantId),
    entityType: "TENANT",
    tenantId,
    name: "Local demo tenant",
    status: "active",
    createdAt: now,
    version: 1,
  },
  {
    ...key.apiClient(tenantId, clientId),
    entityType: "API_CLIENT",
    clientId,
    tenantId,
    name: "local-demo-producer",
    status: "active",
    scopes: ["events:submit", "events:read"],
    secretVersions: [{ reference, state: "active", activatedAt: now }],
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
  ...identities.map(([subject, role, userId]) => ({
    ...key.identity(issuer, subject),
    entityType: "USER_IDENTITY",
    issuer,
    subject,
    tenantId,
    status: "active",
    role,
    userId,
  })),
]);
const alphaPartnerId = "ptr_01J0A1B2C3D4E5F6G7H8J90001" as never;
if ((await persistence.getPartner(seedContext, alphaPartnerId)) === undefined) {
  let sequence = 0;
  const ids = {
    next: (prefix: string) =>
      `${prefix}_01J0A1B2C3D4E5F6G7H8J9${String(++sequence).padStart(4, "0")}`,
  };
  const service = new ControlPlaneService({
    repository: persistence,
    audit: persistence,
    secrets: store,
    endpoints: new SafePartnerHttpClient({
      mode: "local",
      localHttpHostnames: ["mock-partner-alpha", "mock-partner-beta"],
    }),
    execute: executeTransformation,
    ids: ids as never,
    clock: { now: () => new Date() },
  });
  const alpha = await service.createPartner(seedContext, {
    name: "Mock Partner Alpha",
    externalKey: "mock-alpha",
    enabled: true,
  });
  const beta = await service.createPartner(seedContext, {
    name: "Mock Partner Beta",
    externalKey: "mock-beta",
    enabled: true,
  });
  const alphaTransformation = await service.createTransformation(seedContext, {
    externalKey: "alpha-shipment-v1",
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
          transform: "UPPER_SNAKE",
          required: true,
        },
        {
          target: "$.estimated_delivery",
          source: "$.data.estimatedDelivery",
          transform: "ISO_DATE",
        },
        { target: "$.event_reference", source: "$.eventId", required: true },
      ],
    } as never,
  });
  const betaTransformation = await service.createTransformation(seedContext, {
    externalKey: "beta-shipment-v1",
    definition: {
      schemaVersion: 1,
      contentType: "application/json",
      mappings: [
        { target: "$.shipment.id", source: "$.subject.id", required: true },
        {
          target: "$.shipment.tracking.number",
          source: "$.data.trackingNumber",
          required: true,
        },
        {
          target: "$.shipment.currentState",
          source: "$.data.status",
          transform: "ENUM_MAP",
          values: { in_transit: "MOVING" },
          required: true,
        },
        {
          target: "$.shipment.estimatedDeliveryDate",
          source: "$.data.estimatedDelivery",
          transform: "ISO_DATE",
        },
        { target: "$.sourceEvent.id", source: "$.eventId", required: true },
        {
          target: "$.sourceEvent.occurredAt",
          source: "$.occurredAt",
          required: true,
        },
      ],
    } as never,
  });
  const policy = {
    maxAttempts: 5,
    initialDelaySeconds: 5,
    multiplier: 2,
    maxDelaySeconds: 1800,
    jitter: "FULL_UPPER_HALF" as const,
  };
  const circuit = {
    failureThreshold: 5,
    cooldownSeconds: 60,
    probeLeaseSeconds: 20,
  };
  const alphaDestination = await service.createDestination(seedContext, {
    partnerId: alpha.partnerId,
    name: "Alpha shipments",
    externalKey: "alpha-shipments",
    baseUrl: "http://mock-partner-alpha:4011",
    path: "/webhooks/shipments",
    method: "POST",
    enabled: true,
    authType: "api_key",
    authConfiguration: {
      headerName: "X-API-Key",
      idempotencyHeader: "Idempotency-Key",
    },
    timeoutMs: 8000,
    retryPolicy: policy,
    rateLimitPolicy: {
      requestsPerInterval: 60,
      intervalSeconds: 60,
      burstCapacity: 60,
      safetyFactor: 1,
    },
    circuitBreakerPolicy: circuit,
    transformationId: alphaTransformation.transformationId,
    activeTransformationVersion: 1,
    sensitiveResponseJsonPaths: [],
    credential: { alias: "alpha-api-key", value: alphaKey },
  } as never);
  const betaDestination = await service.createDestination(seedContext, {
    partnerId: beta.partnerId,
    name: "Beta shipments",
    externalKey: "beta-shipments",
    baseUrl: "http://mock-partner-beta:4012",
    path: "/api/shipments",
    method: "POST",
    enabled: true,
    authType: "oauth_client_credentials",
    authConfiguration: {
      tokenUrl: "http://mock-partner-beta:4012/oauth/token",
      clientId: "beta-demo",
      scopes: [],
      authenticationStyle: "basic",
    },
    timeoutMs: 8000,
    retryPolicy: policy,
    rateLimitPolicy: {
      requestsPerInterval: 10,
      intervalSeconds: 1,
      burstCapacity: 10,
      safetyFactor: 1,
    },
    circuitBreakerPolicy: circuit,
    transformationId: betaTransformation.transformationId,
    activeTransformationVersion: 1,
    sensitiveResponseJsonPaths: [],
    credential: { alias: "beta-client-secret", value: betaSecret },
  } as never);
  await service.createSubscription(seedContext, {
    externalKey: "alpha-shipment-status",
    destinationId: alphaDestination.destinationId,
    eventType: "shipment.status_changed",
    enabled: true,
  });
  await service.createSubscription(seedContext, {
    externalKey: "beta-shipment-status",
    destinationId: betaDestination.destinationId,
    eventType: "shipment.status_changed",
    enabled: true,
  });
}
console.log(
  "Local M02 tenant, identities, producer client, and M03 partner configuration seeded idempotently.",
);
