import { expect, test } from "vitest";
import { DeliveryService } from "../../packages/application/src/index.js";

const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const eventId = "evt_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const deliveryId = "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const destinationId = "dst_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const correlationId = "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
const now = new Date("2026-08-27T00:00:00.000Z");

function delivery(oauth = false): Record<string, unknown> {
  return {
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
    configSnapshot: {
      destinationVersion: 1,
      url: "https://example.test/deliver",
      method: "POST",
      timeoutMs: 1_000,
      retryPolicy: {
        maxAttempts: 2,
        initialDelaySeconds: 5,
        multiplier: 2,
        maxDelaySeconds: 60,
        jitter: "FULL_UPPER_HALF",
      },
      rateLimitPolicyId: "rate-v1",
      circuitBreakerPolicyId: "circuit-v1",
      authType: oauth ? "oauth_client_credentials" : "api_key",
      authConfiguration: oauth
        ? {
            tokenUrl: "https://example.test/token",
            clientId: "client-id",
            authenticationStyle: "body",
            scopes: [],
          }
        : { headerName: "x-api-key" },
      secretReferenceNames: ["partner-key"],
      transformationId: "trf_01J0A1B2C3D4E5F6G7H8J9K0MN",
      transformationVersion: 1,
      redactionPaths: [],
    },
    transformedPayload: { status: "accepted" },
    transformedPayloadHash: "payload-hash",
    partnerIdempotencyKey: "partner-idempotency-key",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
}

function dependencies(input: {
  readonly enabled?: boolean;
  readonly secretError?: Error;
  readonly oauthError?: Error;
  readonly httpError?: Error;
  readonly finalize?: () => boolean | Promise<boolean>;
}) {
  const initial = delivery(input.oauthError !== undefined);
  let requestCount = 0;
  let deferred = 0;
  let finalized: Record<string, unknown> | undefined;
  let id = 0;
  const service = new DeliveryService({
    core: {
      getDelivery: async () => initial,
      getDestination: async () =>
        ({
          enabled: input.enabled ?? true,
          circuitBreakerPolicy: {
            failureThreshold: 3,
            cooldownSeconds: 30,
            probeLeaseSeconds: 20,
          },
          rateLimitPolicy: {
            requestsPerInterval: 10,
            intervalSeconds: 1,
            burstCapacity: 1,
            safetyFactor: 1,
          },
        }) as never,
    },
    repository: {
      acquireLease: async (value: { readonly token: string }) =>
        ({
          ...initial,
          state: "in_progress",
          nextEligibleAt: undefined,
          leaseOwner: "worker",
          leaseToken: value.token,
          leaseExpiresAt: new Date(now.getTime() + 6_000).toISOString(),
          version: 2,
        }) as never,
      acquireCircuitPermit: async () =>
        ({
          allowed: true,
          probe: false,
          state: { state: "CLOSED", consecutiveFailures: 0, version: 1 },
        }) as never,
      acquireRatePermit: async () => ({ permitted: true, nextEligibleAt: now }),
      startAttempt: async (value: {
        delivery: Record<string, unknown>;
        attempt: { attemptId: string };
      }) =>
        ({
          ...value.delivery,
          activeAttemptId: value.attempt.attemptId,
          version: Number(value.delivery.version) + 1,
        }) as never,
      circuitAfterAttempt: () =>
        ({ state: "CLOSED", consecutiveFailures: 0, version: 2 }) as never,
      finalizeAttempt: async (value: Record<string, unknown>) => {
        finalized = value;
        return input.finalize === undefined ? true : input.finalize();
      },
      defer: async () => {
        deferred += 1;
        return true;
      },
    },
    secrets: {
      resolve: async () => {
        if (input.secretError !== undefined) throw input.secretError;
        return { value: "test-secret", version: "v1" };
      },
    },
    oauth: {
      get: async () => {
        if (input.oauthError !== undefined) throw input.oauthError;
        return "unused";
      },
    },
    http: {
      send: async () => {
        requestCount += 1;
        if (input.httpError !== undefined) throw input.httpError;
        return { status: 202, headers: {}, body: "{}" };
      },
    },
    ids: {
      next: (prefix: string) => `${prefix}_01J0A1B2C3D4E5F6G7H8J9K0M${id++}`,
    },
    clock: { now: () => now },
    random: { next: () => 0 },
  } as never);
  return {
    service,
    state: () => ({ requestCount, deferred, finalized }),
  };
}

const input = { tenantId, eventId, deliveryId, correlationId, owner: "worker" };

test("M12 missing-secret, OAuth, and partner-timeout paths finalize immutable failure evidence", async () => {
  for (const scenario of [
    {
      label: "missing secret",
      secretError: new Error("SECRET_NOT_FOUND"),
      category: "SECRET_NOT_FOUND",
    },
    {
      label: "OAuth failure",
      oauthError: new Error("OAUTH_FAILURE"),
      category: "OAUTH_TOKEN_ERROR",
    },
    {
      label: "partner timeout",
      httpError: new Error("PARTNER_TIMEOUT"),
      category: "TIMEOUT",
    },
  ]) {
    const fixture = dependencies(scenario);
    await expect(fixture.service.deliver(input)).resolves.toEqual({
      acknowledge: true,
    });
    const finalization = fixture.state().finalized as {
      attempt: { failureCategory?: string };
    };
    expect(finalization.attempt.failureCategory, scenario.label).toBe(
      scenario.category,
    );
  }
});

test("M12 destination disable during an active delivery defers without an outbound call", async () => {
  const fixture = dependencies({ enabled: false });
  await expect(fixture.service.deliver(input)).resolves.toEqual({
    acknowledge: true,
  });
  expect(fixture.state()).toMatchObject({ requestCount: 0, deferred: 1 });
});

test("M12 post-partner crash and finalization conflict leave recovery to the durable lease", async () => {
  for (const finalize of [
    () => {
      throw new Error("simulated crash after partner response");
    },
    () => false,
  ]) {
    const fixture = dependencies({ finalize });
    await expect(fixture.service.deliver(input)).rejects.toThrow(
      /simulated crash|DELIVERY_FINALIZATION_CONFLICT/,
    );
    expect(fixture.state().requestCount).toBe(1);
  }
});
