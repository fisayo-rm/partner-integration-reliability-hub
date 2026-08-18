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
  DeliveryExecution,
  Destination,
  OutboxRecord,
  Partner,
  TenantContext,
  TransformationVersion,
} from "../../packages/domain/src/index.js";
import { ReplayService } from "../../packages/application/src/index.js";

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
    status: "accepted",
    outcome: {
      routingComplete: false,
      totalDeliveries: 0,
      terminalDeliveries: 0,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 0,
      deadLetteredDeliveries: 0,
    },
    version: 1,
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
    payload: {
      eventId: event.eventId,
      correlationId: event.correlationId,
      cause: "INITIAL",
    },
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
  expect((await persistence.accept(input)).kind).toBe("accepted");
  expect((await persistence.accept(input)).kind).toBe("duplicate");
  expect(
    (await persistence.accept({ ...input, requestBodyHash: "other" })).kind,
  ).toBe("conflict");
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
test("M03 local seed provides two tenant-scoped partner configurations and alias-only credentials", async () => {
  const seeded: TenantContext = {
    tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
    actorType: "system",
    actorId: "m03-seed-check",
    requestId: "m03-seed-check",
    correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
  };
  const alpha = await persistence.getPartner(
    seeded,
    "ptr_01J0A1B2C3D4E5F6G7H8J90001" as never,
  );
  expect(alpha).toMatchObject({
    name: "Mock Partner Alpha",
    externalKey: "mock-alpha",
  });
  const destination = await persistence.getDestination(
    seeded,
    "dst_01J0A1B2C3D4E5F6G7H8J90010" as never,
  );
  expect(JSON.stringify(destination)).not.toContain("credential");
  const subscriptions = await persistence.listSubscriptions(
    seeded,
    "shipment.status_changed",
  );
  expect(subscriptions).toHaveLength(2);
  const secrets = new LocalDynamoDbSecretStore(documentClient, {
    coreTableName,
    masterKeyBase64: masterKey,
  });
  await expect(
    secrets.resolve(seeded, { name: "alpha-api-key" }),
  ).resolves.toMatchObject({
    value: expect.any(String),
  });
});

test("M06 replay is race-safe, immutable, searchable, audited, and rolled up", async () => {
  const now = "2026-08-18T08:00:00.000Z" as never;
  const eventId =
    `evt_21J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never;
  const deliveryId =
    `dlv_21J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never;
  const destinationId =
    `dst_21J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never;
  const partnerId =
    `ptr_21J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never;
  const transformationId =
    `trf_21J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never;
  const event: CanonicalEvent = {
    eventId,
    tenantId: tenantA,
    producerClientId: "cli_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
    correlationId:
      `cor_21J0A1B2C3D4E5F6G7H8${suffix.slice(0, 6).toUpperCase()}` as never,
    eventType: "shipment.status_changed",
    occurredAt: now,
    acceptedAt: now,
    subject: { type: "shipment", id: "replay" },
    data: { trackingNumber: "T-1" },
    metadata: {},
    payloadHash: "event-hash",
    status: "failed",
    outcome: {
      routingComplete: true,
      totalDeliveries: 1,
      terminalDeliveries: 1,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 1,
      deadLetteredDeliveries: 0,
    },
    version: 3,
    expiresAt: "2026-09-18T08:00:00.000Z" as never,
  };
  const destination: Destination = {
    destinationId,
    tenantId: tenantA,
    partnerId,
    name: "Replay destination",
    externalKey: "replay-destination" as never,
    baseUrl: "https://example.test",
    path: "/hook",
    method: "POST",
    enabled: true,
    authType: "api_key",
    authConfiguration: { idempotencyHeader: "Idempotency-Key" },
    secretReferences: [{ name: "replay-secret" }],
    timeoutMs: 1_000,
    retryPolicy: {
      maxAttempts: 2,
      initialDelaySeconds: 1,
      multiplier: 2,
      maxDelaySeconds: 5,
      jitter: "FULL_UPPER_HALF",
    },
    rateLimitPolicy: {
      requestsPerInterval: 1,
      intervalSeconds: 1,
      burstCapacity: 1,
      safetyFactor: 1,
    },
    circuitBreakerPolicy: {
      failureThreshold: 2,
      cooldownSeconds: 1,
      probeLeaseSeconds: 1,
    },
    transformationId,
    activeTransformationVersion: 2,
    sensitiveResponseJsonPaths: ["$.secret"],
    version: 7,
  };
  const original: DeliveryExecution = {
    deliveryId,
    eventId,
    correlationId: event.correlationId,
    tenantId: tenantA,
    partnerId,
    destinationId,
    executionType: "ORIGINAL",
    state: "failed_terminal",
    blockedReason: "OAUTH_TOKEN_ERROR",
    lastFailureCategory: "OAUTH_TOKEN_ERROR",
    attemptCount: 1,
    maxAttempts: 2,
    configSnapshot: {
      destinationVersion: 6,
      url: "https://old.example.test/hook",
      method: "POST",
      timeoutMs: 1_000,
      retryPolicy: destination.retryPolicy,
      rateLimitPolicyId: "old-rate",
      circuitBreakerPolicyId: "old-circuit",
      authType: "api_key",
      authConfiguration: {},
      secretReferenceNames: ["old-secret"],
      transformationId,
      transformationVersion: 1,
      redactionPaths: ["$.secret"],
    },
    transformedPayload: { secret: "old" },
    transformedPayloadHash: "old-hash",
    partnerIdempotencyKey: "old-key",
    createdAt: now,
    updatedAt: now,
    terminalAt: now,
    version: 5,
    expiresAt: event.expiresAt,
  };
  const transformation: TransformationVersion = {
    transformationId,
    externalKey: "replay-transform" as never,
    tenantId: tenantA,
    version: 2,
    definition: {},
    createdAt: now,
    createdBy: "admin",
  };
  const partner: Partner = {
    partnerId,
    tenantId: tenantA,
    name: "Replay partner",
    externalKey: "replay-partner" as never,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  await persistence.putSeed([
    {
      ...key.event(tenantA, eventId),
      entityType: "EVENT",
      ...event,
      expiresAt: epochSeconds(event.expiresAt),
    },
    {
      ...key.lookup(tenantA, "DELIVERY", deliveryId),
      entityType: "LOOKUP",
      eventId,
    },
    {
      ...key.lookup(tenantA, "CORRELATION", event.correlationId),
      entityType: "LOOKUP",
      eventId,
    },
    {
      ...key.delivery(tenantA, eventId, deliveryId),
      entityType: "DELIVERY",
      ...original,
      expiresAt: epochSeconds(original.expiresAt),
    },
    {
      ...key.destination(tenantA, destinationId),
      entityType: "DESTINATION",
      ...destination,
    },
    { ...key.partner(tenantA, partnerId), entityType: "PARTNER", ...partner },
    {
      ...key.transformation(tenantA, transformationId, 2),
      entityType: "TRANSFORMATION_VERSION",
      ...transformation,
    },
  ]);
  const operator = {
    ...context(tenantA),
    actorType: "console_user" as const,
    actorId: "operator",
    role: "operator" as const,
  };
  const replay = new ReplayService({
    core: persistence,
    repository: persistence,
    execute: () => ({
      output: { secret: "new", replay: true },
      hash: "new-hash",
    }),
    ids: { next: (prefix) => `${prefix}_01J0A1B2C3D4E5F6G7H8J9K0MN` },
    clock: { now: () => new Date(now) },
    retentionDays: 30,
  });
  const input = {
    deliveryId,
    idempotencyKey: `replay-${suffix}`,
    reason: "OAuth credentials were corrected",
    correctionConfirmed: true,
  };
  const results = await Promise.all([
    replay.replay(operator, input),
    replay.replay(operator, input),
  ]);
  expect(results.filter((value) => !value.previouslyAccepted)).toHaveLength(1);
  expect(results.filter((value) => value.previouslyAccepted)).toHaveLength(1);
  await expect(persistence.getEvent(operator, eventId)).resolves.toMatchObject({
    status: "failed",
    outcome: event.outcome,
    version: 3,
  });
  const detail = await persistence.getDeliveryDetail(operator, deliveryId);
  expect(detail?.replayRelations).toHaveLength(1);
  expect(detail?.replayRelations[0]).toMatchObject({
    originalDestinationVersion: 6,
    replayDestinationVersion: 7,
    originalTransformationVersion: 1,
    replayTransformationVersion: 2,
  });
  await expect(
    persistence.searchDeliveries(operator, {
      limit: 10,
      from: "2026-08-18T00:00:00.000Z",
      to: "2026-08-19T00:00:00.000Z",
      correlationId: event.correlationId,
    }),
  ).resolves.toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ deliveryId })]),
  });
  await expect(
    persistence.listAudit(operator, {
      limit: 10,
      from: "2026-08-18T00:00:00.000Z",
      to: "2026-08-19T00:00:00.000Z",
      status: "delivery.replay_requested",
    }),
  ).resolves.toMatchObject({
    items: [expect.objectContaining({ targetId: deliveryId })],
  });
  await expect(
    persistence.getRollups(operator, {
      from: "2026-08-18T08:00:00.000Z",
      to: "2026-08-18T08:00:00.000Z",
    }),
  ).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ replaysRequested: 1 })]),
  );
});
