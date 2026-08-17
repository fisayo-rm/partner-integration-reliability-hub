import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectTenantIsolation } from "../../packages/test-support/src/index.js";
import {
  DynamoPersistence,
  epochSeconds,
  isExpired,
  key,
} from "../../packages/persistence/src/index.js";
import { LocalDynamoDbSecretStore } from "../../packages/secrets/src/index.js";
import {
  AuthenticationError,
  ConsoleAuthenticator,
  OidcAccessTokenVerifier,
} from "../../packages/auth/src/index.js";
import type {
  CanonicalEvent,
  OutboxRecord,
  TenantContext,
} from "../../packages/domain/src/index.js";

const suffix = randomBytes(6).toString("hex");
const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const coreTableName = process.env.CORE_TABLE_NAME ?? "pirh-core-local";
const auditTableName = process.env.AUDIT_TABLE_NAME ?? "pirh-audit-local";
const documentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
);
const persistence = new DynamoPersistence(documentClient, {
  coreTableName,
  auditTableName,
  outboxShardCount: 8,
});
const masterKey =
  process.env.M02_TEST_MASTER_KEY_B64 ?? Buffer.alloc(32, 7).toString("base64");
const tenantA =
  `tenant_01J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never;
const tenantB =
  `tenant_11J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never;
const context = (tenantId: TenantContext["tenantId"]): TenantContext => ({
  tenantId,
  actorType: "system",
  actorId: "integration",
  requestId: `req_${suffix}`,
  correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
});

beforeAll(async () => {
  await persistence.putSeed([
    {
      ...key.tenant(tenantA),
      entityType: "TENANT",
      tenantId: tenantA,
      name: "A",
      status: "active",
      createdAt: new Date().toISOString(),
      version: 1,
    },
    {
      ...key.tenant(tenantB),
      entityType: "TENANT",
      tenantId: tenantB,
      name: "B",
      status: "active",
      createdAt: new Date().toISOString(),
      version: 1,
    },
    {
      ...key.destination(tenantA, "dst_01J0A1B2C3D4E5F6G7H8J9K0MN"),
      entityType: "DESTINATION",
      destinationId: "dst_01J0A1B2C3D4E5F6G7H8J9K0MN",
      tenantId: tenantA,
      name: "isolated",
    },
  ]);
});
afterAll(async () => documentClient.destroy());
test("tenant-keyed reads do not reveal direct object references across tenants", async () => {
  await expectTenantIsolation({
    owner: context(tenantA),
    intruder: context(tenantB),
    operation: (owner) =>
      persistence.getDestination(
        owner,
        "dst_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
      ),
  });
});
test("nonces are conditional, TTL uses epoch seconds, and local secret ciphertext is tenant-bound", async () => {
  const result = await Promise.all(
    [1, 2].map(() =>
      persistence.putIfAbsent({
        tenantId: tenantA,
        clientId: "cli_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
        nonceHash: suffix,
        expiresAt: new Date(Date.now() + 300_000),
      }),
    ),
  );
  expect(result.filter(Boolean)).toHaveLength(1);
  expect(epochSeconds("2026-01-01T00:00:00.000Z")).toBe(1767225600);
  expect(
    isExpired({ expiresAt: epochSeconds(new Date(Date.now() - 1_000)) }),
  ).toBe(true);
  const secrets = new LocalDynamoDbSecretStore(documentClient, {
    coreTableName,
    masterKeyBase64: masterKey,
  });
  const reference = await secrets.store(context(tenantA), {
    name: `secret-${suffix}`,
    version: "v1",
    value: "plaintext-must-not-persist",
  });
  const raw = await documentClient.send(
    new GetCommand({
      TableName: coreTableName,
      Key: key.secret(tenantA, reference.name, "v1"),
    }),
  );
  expect(JSON.stringify(raw.Item)).not.toContain("plaintext-must-not-persist");
  await expect(
    secrets.resolve(context(tenantA), reference),
  ).resolves.toMatchObject({ value: "plaintext-must-not-persist" });
  await expect(secrets.resolve(context(tenantB), reference)).rejects.toThrow(
    "could not be resolved",
  );
});
test("event/idempotency/outbox persistence is atomic and duplicate-safe", async () => {
  const now = new Date().toISOString() as never;
  const event: CanonicalEvent = {
    eventId:
      `evt_01J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never,
    tenantId: tenantA,
    producerClientId: "cli_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
    correlationId:
      `cor_01J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never,
    eventType: "shipment.status_changed",
    occurredAt: now,
    acceptedAt: now,
    subject: { type: "shipment", id: "s" },
    data: {},
    metadata: {},
    payloadHash: "hash",
    outcome: {
      routingComplete: false,
      totalDeliveries: 0,
      terminalDeliveries: 0,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 0,
      deadLetteredDeliveries: 0,
    },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() as never,
  };
  const outbox: OutboxRecord = {
    outboxId:
      `obx_01J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never,
    kind: "ROUTE_EVENT",
    tenantId: tenantA,
    aggregateType: "EVENT",
    aggregateId: event.eventId,
    target: "ROUTING_QUEUE",
    payload: { eventId: event.eventId },
    createdAt: now,
    attempts: 0,
    schemaVersion: 1,
  };
  const input = {
    context: context(tenantA),
    event,
    requestBodyHash: "body",
    idempotencyKeyHash: `id-${suffix}`,
    responseStatus: 202,
    outbox,
  };
  expect(await persistence.accept(input)).toBe("accepted");
  expect(await persistence.accept(input)).toBe("duplicate");
  expect(await persistence.accept({ ...input, requestBodyHash: "other" })).toBe(
    "conflict",
  );
  await expect(
    persistence.getEvent(context(tenantA), event.eventId),
  ).resolves.toMatchObject({ eventId: event.eventId });
});
test("Keycloak discovery/JWKS tokens establish the persisted viewer tenant context", async () => {
  const issuer =
    process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/pirh-local";
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "pirh-console",
    username: "viewer@example.test",
    password: "viewer-demo-only",
  });
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = (await response.json()) as { access_token?: string };
  expect(response.ok, JSON.stringify(token)).toBe(true);
  const verifier = new OidcAccessTokenVerifier({
    issuer,
    audience: "pirh-console",
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
    allowedAlgorithms: ["RS256"],
    tokenUseClaim: "typ",
    tokenUseValue: "Bearer",
  });
  const authenticated = await new ConsoleAuthenticator(
    verifier,
    persistence,
  ).authenticate(
    token.access_token ?? "",
    "keycloak-test",
    "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
  );
  expect(authenticated).toMatchObject({
    tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN",
    role: "viewer",
  });
  const wrongAudience = new OidcAccessTokenVerifier({
    ...{
      issuer,
      audience: "not-pirh",
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
      allowedAlgorithms: ["RS256"],
      tokenUseClaim: "typ",
      tokenUseValue: "Bearer",
    },
  });
  await expect(
    wrongAudience.verifyAccessToken(token.access_token ?? ""),
  ).rejects.toBeInstanceOf(AuthenticationError);
});
