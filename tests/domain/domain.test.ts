import { describe, expect, test } from "vitest";
import {
  asIdentifier,
  classifyDeliveryResult,
  deriveEventStatus,
  failureCategories,
  isTerminalDeliveryState,
  parseRetryAfter,
  rateLimitDecision,
  retryDelaySeconds,
  transitionDelivery,
  type DeliveryExecution,
  type EventOutcomeCounters,
} from "../../packages/domain/src/index.js";
import {
  FixedClock,
  SequenceIdGenerator,
  SequenceRandom,
} from "../../packages/test-support/src/index.js";

const ulid = "01J0A1B2C3D4E5F6G7H8J9K0MN";
const id = <T extends string>(prefix: string) =>
  asIdentifier<T>(prefix, `${prefix}_${ulid}`);
const instant = "2026-08-13T12:00:00.000Z" as never;
function delivery(
  state: DeliveryExecution["state"] = "pending",
): DeliveryExecution {
  return {
    deliveryId: id<"DeliveryId">("dlv"),
    eventId: id<"EventId">("evt"),
    correlationId: id<"CorrelationId">("cor"),
    tenantId: id<"TenantId">("tenant"),
    partnerId: id<"PartnerId">("ptr"),
    destinationId: id<"DestinationId">("dst"),
    executionType: "ORIGINAL",
    state,
    attemptCount: 0,
    maxAttempts: 5,
    configSnapshot: {
      destinationVersion: 1,
      url: "https://example.test",
      method: "POST",
      timeoutMs: 8_000,
      retryPolicy: {
        maxAttempts: 5,
        initialDelaySeconds: 5,
        multiplier: 2,
        maxDelaySeconds: 1800,
        jitter: "FULL_UPPER_HALF",
      },
      rateLimitPolicyId: "rate-default",
      circuitBreakerPolicyId: "circuit-default",
      authType: "api_key",
      authConfiguration: {},
      secretReferenceNames: [],
      transformationId: id<"TransformationId">("trf"),
      transformationVersion: 1,
      redactionPaths: [],
    },
    transformedPayload: {},
    transformedPayloadHash: "hash",
    partnerIdempotencyKey: "key",
    createdAt: instant,
    updatedAt: instant,
    version: 1,
    expiresAt: instant,
  };
}
const complete: EventOutcomeCounters = {
  routingComplete: true,
  totalDeliveries: 2,
  terminalDeliveries: 2,
  successfulDeliveries: 1,
  failedTerminalDeliveries: 1,
  deadLetteredDeliveries: 0,
};

describe("delivery state transitions", () => {
  test("enforces the pending-to-scheduled and lease-guarded in-progress path", () => {
    const scheduled = transitionDelivery(delivery(), {
      to: "scheduled",
      at: instant,
      expectedVersion: 1,
      nextEligibleAt: instant,
    });
    const token = id<"LeaseToken">("lease");
    const started = transitionDelivery(scheduled, {
      to: "in_progress",
      at: instant,
      expectedVersion: 2,
      lease: { owner: "worker-1", token, expiresAt: instant },
    });
    const succeeded = transitionDelivery(started, {
      to: "succeeded",
      at: instant,
      expectedVersion: 3,
      leaseToken: token,
    });
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.version).toBe(4);
    expect(isTerminalDeliveryState(succeeded.state)).toBe(true);
  });
  test("allows a retry-scheduled delivery to acquire its second-attempt lease", () => {
    const retryScheduled = {
      ...delivery("retry_scheduled"),
      attemptCount: 1,
      nextEligibleAt: instant,
    };
    const resumed = transitionDelivery(retryScheduled, {
      to: "in_progress",
      at: instant,
      expectedVersion: 1,
      lease: {
        owner: "worker-2",
        token: id<"LeaseToken">("retry-lease"),
        expiresAt: instant,
      },
    });
    expect(resumed.state).toBe("in_progress");
    expect(resumed.attemptCount).toBe(1);
  });
  test("rejects invalid or unleased transitions", () => {
    expect(() =>
      transitionDelivery(delivery(), {
        to: "succeeded",
        at: instant,
        expectedVersion: 1,
      }),
    ).toThrow("Cannot transition");
    const inProgress = {
      ...delivery("in_progress"),
      leaseToken: id<"LeaseToken">("lease"),
    };
    expect(() =>
      transitionDelivery(inProgress, {
        to: "failed_terminal",
        at: instant,
        expectedVersion: 1,
        leaseToken: id<"LeaseToken">("other"),
      }),
    ).toThrow("active lease token");
  });
});
test("derives every event outcome state and rejects inconsistent counters", () => {
  expect(
    deriveEventStatus({
      ...complete,
      routingComplete: false,
      totalDeliveries: 0,
      terminalDeliveries: 0,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 0,
    }),
  ).toBe("accepted");
  expect(
    deriveEventStatus({
      ...complete,
      routingComplete: false,
      terminalDeliveries: 0,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 0,
    }),
  ).toBe("processing");
  expect(
    deriveEventStatus({
      ...complete,
      totalDeliveries: 0,
      terminalDeliveries: 0,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 0,
    }),
  ).toBe("no_destinations");
  expect(
    deriveEventStatus({
      ...complete,
      terminalDeliveries: 1,
      successfulDeliveries: 1,
      failedTerminalDeliveries: 0,
    }),
  ).toBe("processing");
  expect(
    deriveEventStatus({
      ...complete,
      successfulDeliveries: 2,
      failedTerminalDeliveries: 0,
    }),
  ).toBe("succeeded");
  expect(deriveEventStatus(complete)).toBe("partially_succeeded");
  expect(
    deriveEventStatus({
      ...complete,
      successfulDeliveries: 0,
      failedTerminalDeliveries: 2,
    }),
  ).toBe("failed");
  expect(() =>
    deriveEventStatus({ ...complete, terminalDeliveries: 3 }),
  ).toThrow("inconsistent");
});
test("keeps failure categories, identifiers, clocks, and random sources deterministic", () => {
  expect(failureCategories).toHaveLength(17);
  expect(id<"EventId">("evt")).toMatch(/^evt_/);
  expect(() => asIdentifier("evt", "evt_not-a-ulid")).toThrow("ULID");
  expect(
    new FixedClock(new Date("2026-08-13T00:00:00Z")).now().toISOString(),
  ).toBe("2026-08-13T00:00:00.000Z");
  expect(new SequenceRandom([0.25, 0.75]).next()).toBe(0.25);
  expect(new SequenceIdGenerator([ulid]).next("cor")).toBe(`cor_${ulid}`);
});

test("classifies retry outcomes and computes bounded retry/rate decisions", () => {
  expect(classifyDeliveryResult({ status: 503 })).toMatchObject({
    retryable: true,
    failureCategory: "PARTNER_5XX",
    countsTowardCircuit: true,
  });
  expect(classifyDeliveryResult({ status: 401 })).toMatchObject({
    retryable: false,
    failureCategory: "PARTNER_4XX",
  });
  expect(classifyDeliveryResult({ errorCode: "TIMEOUT" })).toMatchObject({
    retryable: true,
    failureCategory: "TIMEOUT",
  });
  const policy = delivery().configSnapshot.retryPolicy;
  expect(retryDelaySeconds({ policy, attemptNumber: 2, random: 0 })).toBe(5);
  expect(
    retryDelaySeconds({
      policy,
      attemptNumber: 2,
      random: 0.5,
      retryAfterSeconds: 30,
    }),
  ).toBe(30);
  expect(parseRetryAfter("3", new Date(0))).toBe(3);
  expect(parseRetryAfter("invalid", new Date(0))).toBeUndefined();
  const rate = {
    requestsPerInterval: 1,
    intervalSeconds: 1,
    burstCapacity: 1,
    safetyFactor: 1,
  };
  const first = rateLimitDecision({ policy: rate, nowMs: 1_000 });
  expect(first.permitted).toBe(true);
  expect(
    rateLimitDecision({
      policy: rate,
      nowMs: 1_001,
      state: {
        theoreticalArrivalTimeMs: first.nextTheoreticalArrivalTimeMs ?? 0,
        updatedAt: instant,
        policyHash: "policy",
        version: 1,
      },
    }).permitted,
  ).toBe(false);
});
