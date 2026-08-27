import { expect, test } from "vitest";
import { DynamoPersistence } from "../../packages/persistence/src/index.js";

const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const eventId = "evt_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const deliveryId = "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const destinationId = "dst_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const correlationId = "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const now = new Date("2026-08-27T00:00:00.000Z");
const context = {
  tenantId,
  actorType: "system",
  actorId: "m12-concurrency",
  requestId: "req_01J0A1B2C3D4E5F6G7H8J9K0MN",
  correlationId,
} as const;

function conditionalFailure() {
  return Object.assign(new Error("conditional write lost the race"), {
    name: "ConditionalCheckFailedException",
  });
}

/**
 * Models two callers reading the same runtime item before one conditional
 * write wins. A loser reads the winner's state on its retry.
 */
function racingPersistence(initial: Record<string, unknown> | undefined) {
  let current = initial;
  let initialReads = 0;
  const client = {
    send: async (command: { input?: Record<string, unknown> }) => {
      const input = command.input ?? {};
      if ("Key" in input) {
        initialReads += 1;
        return { Item: initialReads <= 2 ? initial : current };
      }
      const write =
        "TransactItems" in input
          ? ((
              input.TransactItems as {
                readonly Put?: {
                  readonly Item?: Record<string, unknown>;
                  readonly ExpressionAttributeValues?: Record<string, unknown>;
                };
              }[]
            )[0]?.Put ?? {})
          : {
              Item: input.Item as Record<string, unknown> | undefined,
              ExpressionAttributeValues: input.ExpressionAttributeValues as
                | Record<string, unknown>
                | undefined,
            };
      const expected =
        write.ExpressionAttributeValues?.[":version"] ??
        write.ExpressionAttributeValues?.[":expected"];
      if (
        current !== undefined &&
        typeof expected === "number" &&
        current.version !== expected
      )
        throw conditionalFailure();
      current = write.Item;
      return {};
    },
  };
  return new DynamoPersistence(client as never, {
    coreTableName: "core",
    auditTableName: "audit",
    outboxShardCount: 8,
  });
}

test("M12 duplicate delivery workers allow exactly one conditional lease owner", async () => {
  const persistence = racingPersistence({
    deliveryId,
    eventId,
    correlationId,
    tenantId,
    partnerId: "ptr_01J0A1B2C3D4E5F6G7H8J9K0MN",
    destinationId,
    executionType: "ORIGINAL",
    state: "scheduled",
    attemptCount: 0,
    maxAttempts: 2,
    nextEligibleAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  });
  const leases = await Promise.all(
    ["worker-a", "worker-b"].map((owner) =>
      persistence.acquireLease({
        context,
        eventId,
        deliveryId,
        expectedVersion: 1,
        owner,
        token: `lease_01J0A1B2C3D4E5F6G7H8J9K0M${owner.at(-1)}`,
        expiresAt: new Date(now.getTime() + 10_000).toISOString(),
      }),
    ),
  );
  expect(leases.filter(Boolean)).toHaveLength(1);
  expect(leases.find(Boolean)?.leaseOwner).toMatch(/worker-[ab]/);
});

test("M12 competing half-open probes grant exactly one owner", async () => {
  const persistence = racingPersistence({
    state: "OPEN",
    consecutiveFailures: 3,
    nextProbeAt: now.toISOString(),
    version: 7,
  });
  const probes = await Promise.all(
    ["worker-a", "worker-b"].map((owner) =>
      persistence.acquireCircuitPermit({
        context,
        destinationId,
        owner,
        now,
        policy: {
          failureThreshold: 3,
          cooldownSeconds: 30,
          probeLeaseSeconds: 20,
        },
      }),
    ),
  );
  expect(probes.filter((result) => result.probe)).toHaveLength(1);
  expect(probes.filter((result) => !result.allowed)).toHaveLength(1);
});

test("M12 boundary rate permits allow exactly one worker through", async () => {
  const persistence = racingPersistence(undefined);
  const permits = await Promise.all(
    ["worker-a", "worker-b"].map(() =>
      persistence.acquireRatePermit({
        context,
        destinationId,
        now,
        policy: {
          requestsPerInterval: 1,
          intervalSeconds: 1,
          burstCapacity: 1,
          safetyFactor: 1,
        },
      }),
    ),
  );
  expect(permits.filter((result) => result.permitted)).toHaveLength(1);
  expect(permits.filter((result) => !result.permitted)).toHaveLength(1);
});
