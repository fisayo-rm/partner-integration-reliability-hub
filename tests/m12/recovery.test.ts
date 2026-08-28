import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { DynamoPersistence } from "../../packages/persistence/src/index.js";
import {
  createBackup,
  restoreBackup,
} from "../../packages/recovery/src/index.js";

const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN";

test("M12 lease recovery finalizes a started attempt as one timeout retry", async () => {
  const eventId = "evt_01J0A1B2C3D4E5F6G7H8J9K0MN";
  const deliveryId = "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN";
  const startedAt = "2026-08-26T00:00:00.000Z";
  const now = new Date("2026-08-26T00:00:10.000Z");
  const delivery = {
    deliveryId,
    eventId,
    correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN",
    tenantId,
    partnerId: "ptr_01J0A1B2C3D4E5F6G7H8J9K0MN",
    destinationId: "dst_01J0A1B2C3D4E5F6G7H8J9K0MN",
    executionType: "ORIGINAL",
    state: "in_progress",
    attemptCount: 1,
    maxAttempts: 2,
    activeAttemptId: "att_01J0A1B2C3D4E5F6G7H8J9K0MN",
    leaseToken: "lease_01J0A1B2C3D4E5F6G7H8J9K0MN",
    leaseExpiresAt: "2026-08-26T00:00:05.000Z",
    configSnapshot: {
      retryPolicy: {
        maxAttempts: 2,
        initialDelaySeconds: 10,
        multiplier: 2,
        maxDelaySeconds: 60,
        jitter: "FULL_UPPER_HALF",
      },
    },
    createdAt: startedAt,
    updatedAt: startedAt,
    version: 2,
    expiresAt: "2026-09-26T00:00:00.000Z",
  };
  const attempt = {
    attemptId: delivery.activeAttemptId,
    attemptNumber: 1,
    deliveryId,
    correlationId: delivery.correlationId,
    startedAt,
    requestMethod: "POST",
    requestUrl: "https://example.test",
    requestHeadersRedacted: {},
    requestBodyHash: "hash",
    outcome: "started",
    expiresAt: delivery.expiresAt,
  };
  const event = {
    eventId,
    outcome: {
      routingComplete: true,
      totalDeliveries: 1,
      terminalDeliveries: 0,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 0,
      deadLetteredDeliveries: 0,
    },
    status: "processing",
    version: 1,
    acceptedAt: startedAt,
    expiresAt: delivery.expiresAt,
  };
  let transaction: { readonly TransactItems?: readonly unknown[] } | undefined;
  const repository = new DynamoPersistence(
    {
      send: async (command: {
        input?: {
          Key?: { PK?: string; SK?: string };
          TransactItems?: readonly unknown[];
        };
      }) => {
        if (command.input?.TransactItems !== undefined) {
          transaction = command.input;
          return {};
        }
        const key = command.input?.Key?.SK ?? "";
        const partition = command.input?.Key?.PK ?? "";
        if (partition.endsWith("#LOOKUP") && key === `DELIVERY#${deliveryId}`)
          return { Item: { eventId } };
        if (key === `DELIVERY#${deliveryId}`) return { Item: delivery };
        if (key.includes("#ATTEMPT#")) return { Item: attempt };
        if (partition.endsWith(`#EVENT#${eventId}`) && key === "META")
          return { Item: event };
        return {};
      },
    } as never,
    { coreTableName: "core", auditTableName: "audit", outboxShardCount: 8 },
  );
  await expect(
    repository.recoverExpired({
      context: {
        tenantId: tenantId as never,
        actorType: "system",
        actorId: "test",
        requestId: "req_01J0A1B2C3D4E5F6G7H8J9K0MN",
        correlationId: delivery.correlationId as never,
      },
      eventId: eventId as never,
      deliveryId: deliveryId as never,
      now,
      random: 0,
    }),
  ).resolves.toBe(true);
  const writes = JSON.stringify(transaction);
  expect(writes).toContain('"failureCategory":"TIMEOUT"');
  expect(writes).toContain('"outcome":"failed"');
  expect(writes).toContain('"state":"retry_scheduled"');
  expect(writes).toContain('"cause":"RETRY"');
  // The same durable attempt and lease are conditional transaction predicates;
  // an original worker returning after recovery cannot replace this timeout.
  expect(writes).toContain("activeAttemptId = :attempt");
  expect(writes).toContain("#outcome = :started");
});

test("M12 backup is tenant-scoped, omits local secrets, and writes a manifest checksum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirh-m12-backup-"));
  try {
    const client = {
      send: async (command: { input: { TableName?: string } }) =>
        command.input.TableName === "core"
          ? {
              Items: [
                {
                  PK: `TENANT#${tenantId}`,
                  SK: "META",
                  tenantId,
                  entityType: "TENANT",
                },
                {
                  PK: `TENANT#${tenantId}`,
                  SK: "SECRET#x",
                  tenantId,
                  entityType: "LOCAL_SECRET",
                },
                {
                  PK: "TENANT#other",
                  SK: "META",
                  tenantId: "other",
                  entityType: "TENANT",
                },
              ],
            }
          : {
              Items: [
                {
                  PK: `TENANT#${tenantId}`,
                  SK: "AUDIT#1",
                  tenantId,
                  entityType: "AUDIT",
                },
              ],
            },
    } as never;
    const result = await createBackup({
      client,
      environment: "local",
      tenantId,
      outputDirectory: directory,
      coreTableName: "core",
      auditTableName: "audit",
      now: new Date("2026-08-26T00:00:00.000Z"),
    });
    expect(result.manifest.files.core.recordCount).toBe(1);
    expect(result.manifest.files.audit.recordCount).toBe(1);
    expect(
      JSON.parse(await readFile(result.manifestPath, "utf8")),
    ).toMatchObject({
      version: 1,
      kind: "pirh-recovery-snapshot",
      tenantId,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M12 backup retains tenant-owned lookup, idempotency, outbox, scheduled, and runtime records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirh-m12-recovery-state-"));
  try {
    const tenantPrefix = `TENANT#${tenantId}`;
    const sourceItems = [
      {
        PK: tenantPrefix,
        SK: "META",
        tenantId,
        entityType: "TENANT",
        secretVersions: [
          {
            reference: { name: "alpha-api-key", version: "v1" },
            state: "active",
            activatedAt: "2026-08-26T00:00:00.000Z",
          },
        ],
      },
      { PK: `${tenantPrefix}#LOOKUP`, SK: "EVENT#evt", entityType: "LOOKUP" },
      {
        PK: `${tenantPrefix}#IDEMPOTENCY#client`,
        SK: "KEY#hash",
        entityType: "IDEMPOTENCY",
      },
      {
        PK: "OUTBOX#1",
        SK: "2026-08-26#obx",
        tenantId,
        entityType: "OUTBOX",
      },
      {
        PK: "SCHEDULED_WORK#1",
        SK: "2026-08-26#work",
        tenantId,
        entityType: "SCHEDULED_WORK",
      },
      {
        PK: `${tenantPrefix}#DESTINATION#dst`,
        SK: "RUNTIME#CIRCUIT",
        entityType: "RUNTIME",
      },
      {
        PK: `${tenantPrefix}#EVENT#evt`,
        SK: "DELIVERY#dlv#ATTEMPT#00000001",
        entityType: "DELIVERY_ATTEMPT",
        requestHeadersRedacted: { "X-API-Key": "[REDACTED]" },
      },
    ];
    const result = await createBackup({
      client: {
        send: async (command: { input: { TableName?: string } }) =>
          command.input.TableName === "core"
            ? { Items: sourceItems }
            : { Items: [] },
      } as never,
      environment: "local",
      tenantId,
      outputDirectory: directory,
      coreTableName: "core",
      auditTableName: "audit",
    });
    const content = gunzipSync(
      await readFile(join(directory, result.manifest.files.core.file)),
    ).toString("utf8");
    expect(result.manifest.files.core.recordCount).toBe(sourceItems.length);
    for (const item of sourceItems)
      expect(content).toContain(`"SK":"${item.SK}"`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("M12 restore refuses non-isolated or non-empty targets before any write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirh-m12-restore-"));
  try {
    const source = {
      send: async () => ({ Items: [] }),
    } as never;
    const backup = await createBackup({
      client: source,
      environment: "local",
      tenantId,
      outputDirectory: directory,
      coreTableName: "core",
      auditTableName: "audit",
    });
    await expect(
      restoreBackup({
        client: source,
        manifestPath: backup.manifestPath,
        targetEnvironment: "demo",
        coreTableName: "pirh-restore-core",
        auditTableName: "pirh-restore-audit",
        allowRestore: true,
      }),
    ).rejects.toThrow("exactly restore-test");
    await expect(
      restoreBackup({
        client: source,
        manifestPath: backup.manifestPath,
        targetEnvironment: "restore-test",
        coreTableName: "pirh-demo-core",
        auditTableName: "pirh-restore-audit",
        allowRestore: true,
      }),
    ).rejects.toThrow("pirh-restore-");
    await expect(
      restoreBackup({
        client: {
          send: async () => ({ Items: [{ PK: "occupied" }] }),
        } as never,
        manifestPath: backup.manifestPath,
        targetEnvironment: "restore-test",
        coreTableName: "pirh-restore-core",
        auditTableName: "pirh-restore-audit",
        allowRestore: true,
      }),
    ).rejects.toThrow("not empty");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
