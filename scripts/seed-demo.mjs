import { randomBytes } from "node:crypto";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ControlPlaneService } from "@pirh/application";
import { SafePartnerHttpClient } from "@pirh/partner-http";
import { DynamoPersistence, key } from "@pirh/persistence";
import { SsmParameterSecretStore } from "@pirh/secrets";
import { executeTransformation } from "@pirh/transformation";

const region = process.env.AWS_REGION ?? "us-east-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const coreTable = process.env.CORE_TABLE_NAME;
const auditTable = process.env.AUDIT_TABLE_NAME;
const alphaUrl = process.env.HOSTED_MOCK_ALPHA_URL;
const betaUrl = process.env.HOSTED_MOCK_BETA_URL;
if (
  userPoolId === undefined ||
  coreTable === undefined ||
  auditTable === undefined ||
  alphaUrl === undefined ||
  betaUrl === undefined
)
  throw new Error(
    "COGNITO_USER_POOL_ID, CORE_TABLE_NAME, AUDIT_TABLE_NAME, HOSTED_MOCK_ALPHA_URL, and HOSTED_MOCK_BETA_URL are required.",
  );
const requiredPassword = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 14)
    throw new Error(
      `${name} must be supplied through the protected demo environment.`,
    );
  return value;
};
const cognito = new CognitoIdentityProviderClient({ region });
const ssm = new SSMClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN";

async function parameter(name, create) {
  try {
    const existing = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    if (
      existing.Parameter?.Value === undefined ||
      existing.Parameter.Version === undefined
    )
      throw new Error(`Parameter ${name} could not be resolved.`);
    return {
      value: existing.Parameter.Value,
      version: String(existing.Parameter.Version),
    };
  } catch (error) {
    if (error.name !== "ParameterNotFound") throw error;
  }
  const created = await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: create(),
      Type: "SecureString",
      Overwrite: false,
    }),
  );
  if (created.Version === undefined)
    throw new Error(`Parameter ${name} was not created.`);
  const stored = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  if (stored.Parameter?.Value === undefined)
    throw new Error(`Parameter ${name} could not be resolved.`);
  return { value: stored.Parameter.Value, version: String(created.Version) };
}
async function user(email, group, password) {
  let subject;
  try {
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
    );
    subject = existing.UserAttributes?.find(
      (attribute) => attribute.Name === "sub",
    )?.Value;
  } catch (error) {
    if (error.name !== "UserNotFoundException") throw error;
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        TemporaryPassword: password,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    subject = created.User?.Attributes?.find(
      (attribute) => attribute.Name === "sub",
    )?.Value;
  }
  if (subject === undefined) throw new Error("Cognito subject unavailable.");
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: email,
      GroupName: group,
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  await ddb
    .send(
      new PutCommand({
        TableName: coreTable,
        Item: {
          ...key.identity(process.env.OIDC_ISSUER ?? "cognito", subject),
          entityType: "USER_IDENTITY",
          issuer: process.env.OIDC_ISSUER ?? "cognito",
          subject,
          tenantId,
          userId: email,
          role: group,
          status: "active",
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    )
    .catch((error) => {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    });
}

const [, , , producer, alphaKey, betaClientId, betaSecret] = await Promise.all([
  parameter("/pirh/demo/system/cursor-secret", () =>
    randomBytes(32).toString("base64url"),
  ),
  parameter("/pirh/demo/system/portability-plan-signing-key", () =>
    randomBytes(32).toString("base64"),
  ),
  parameter("/pirh/demo/system/mock-control-token", () =>
    randomBytes(24).toString("base64url"),
  ),
  parameter(`/pirh/demo/tenants/${tenantId}/secrets/producer-current`, () =>
    randomBytes(32).toString("base64url"),
  ),
  parameter("/pirh/demo/mock/alpha/api-key", () =>
    randomBytes(24).toString("base64url"),
  ),
  parameter("/pirh/demo/mock/beta/client-id", () => "pirh-demo-beta"),
  parameter("/pirh/demo/mock/beta/client-secret", () =>
    randomBytes(24).toString("base64url"),
  ),
]);
await user("admin@pirh.demo", "admin", requiredPassword("DEMO_ADMIN_PASSWORD"));
await user(
  "operator@pirh.demo",
  "operator",
  requiredPassword("DEMO_OPERATOR_PASSWORD"),
);
await user(
  "viewer@pirh.demo",
  "viewer",
  requiredPassword("DEMO_VIEWER_PASSWORD"),
);
const persistence = new DynamoPersistence(ddb, {
  coreTableName: coreTable,
  auditTableName: auditTable,
  outboxShardCount: 8,
});
const context = {
  tenantId,
  actorType: "system",
  actorId: "hosted-seeder",
  requestId: "seed",
  correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN",
};
const clientId = "cli_01J0A1B2C3D4E5F6G7H8J9K0MN";
const now = new Date().toISOString();
await persistence.putSeed([
  {
    ...key.tenant(tenantId),
    entityType: "TENANT",
    tenantId,
    externalKey: "tenant-demo",
    name: "Hosted demo tenant",
    status: "active",
    createdAt: now,
    version: 1,
  },
  {
    ...key.apiClient(tenantId, clientId),
    entityType: "API_CLIENT",
    clientId,
    tenantId,
    name: "hosted-demo-producer",
    status: "active",
    scopes: ["events:submit", "events:read"],
    secretVersions: [
      {
        reference: { name: "producer-current", version: producer.version },
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
if (
  (await persistence.getPartnerByExternalKey(context, "mock-alpha")) ===
  undefined
) {
  let sequence = 0;
  const ids = {
    next(prefix) {
      sequence += 1;
      return `${prefix}_01J0A1B2C3D4E5F6G7H8J9${String(sequence).padStart(4, "0")}`;
    },
  };
  const service = new ControlPlaneService({
    repository: persistence,
    audit: persistence,
    secrets: new SsmParameterSecretStore(ssm, "/pirh/demo/tenants"),
    endpoints: new SafePartnerHttpClient({ mode: "hosted" }),
    execute: executeTransformation,
    ids,
    clock: { now: () => new Date() },
  });
  const alpha = await service.createPartner(context, {
    name: "Mock Partner Alpha",
    externalKey: "mock-alpha",
    enabled: true,
  });
  const beta = await service.createPartner(context, {
    name: "Mock Partner Beta",
    externalKey: "mock-beta",
    enabled: true,
  });
  const alphaTransformation = await service.createTransformation(context, {
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
    },
  });
  const betaTransformation = await service.createTransformation(context, {
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
    },
  });
  const retryPolicy = {
    maxAttempts: 5,
    initialDelaySeconds: 5,
    multiplier: 2,
    maxDelaySeconds: 1800,
    jitter: "FULL_UPPER_HALF",
  };
  const circuitBreakerPolicy = {
    failureThreshold: 5,
    cooldownSeconds: 60,
    probeLeaseSeconds: 20,
  };
  const alphaDestination = await service.createDestination(context, {
    partnerId: alpha.partnerId,
    name: "Alpha shipments",
    externalKey: "alpha-shipments",
    baseUrl: alphaUrl,
    path: "/webhooks/shipments",
    method: "POST",
    enabled: true,
    authType: "api_key",
    authConfiguration: {
      headerName: "X-API-Key",
      idempotencyHeader: "Idempotency-Key",
    },
    timeoutMs: 8000,
    retryPolicy,
    rateLimitPolicy: {
      requestsPerInterval: 60,
      intervalSeconds: 60,
      burstCapacity: 60,
      safetyFactor: 1,
    },
    circuitBreakerPolicy,
    transformationId: alphaTransformation.transformationId,
    activeTransformationVersion: 1,
    sensitiveResponseJsonPaths: [],
    credential: { alias: "alpha-api-key", value: alphaKey.value },
  });
  const betaDestination = await service.createDestination(context, {
    partnerId: beta.partnerId,
    name: "Beta shipments",
    externalKey: "beta-shipments",
    baseUrl: betaUrl,
    path: "/api/shipments",
    method: "POST",
    enabled: true,
    authType: "oauth_client_credentials",
    authConfiguration: {
      tokenUrl: new globalThis.URL("/oauth/token", betaUrl).toString(),
      clientId: betaClientId.value,
      scopes: [],
      authenticationStyle: "basic",
    },
    timeoutMs: 8000,
    retryPolicy,
    rateLimitPolicy: {
      requestsPerInterval: 10,
      intervalSeconds: 1,
      burstCapacity: 10,
      safetyFactor: 1,
    },
    circuitBreakerPolicy,
    transformationId: betaTransformation.transformationId,
    activeTransformationVersion: 1,
    sensitiveResponseJsonPaths: [],
    credential: { alias: "beta-client-secret", value: betaSecret.value },
  });
  await service.createSubscription(context, {
    externalKey: "alpha-shipment-status",
    destinationId: alphaDestination.destinationId,
    eventType: "shipment.status_changed",
    enabled: true,
  });
  await service.createSubscription(context, {
    externalKey: "beta-shipment-status",
    destinationId: betaDestination.destinationId,
    eventType: "shipment.status_changed",
    enabled: true,
  });
}
console.log(
  JSON.stringify({
    seeded: true,
    tenantId,
    users: 3,
    parameters: "created-or-preserved",
    catalog: "created-or-preserved",
  }),
);
