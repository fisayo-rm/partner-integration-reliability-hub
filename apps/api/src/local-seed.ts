import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LocalDynamoDbSecretStore } from "@pirh/secrets";
import { DynamoPersistence, key } from "@pirh/persistence";
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
if (masterKey === undefined || producerSecret === undefined)
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
    scopes: ["events:submit"],
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
console.log(
  "Local M02 tenant, identities, and producer client seeded idempotently.",
);
