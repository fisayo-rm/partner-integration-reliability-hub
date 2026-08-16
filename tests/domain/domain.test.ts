import { describe, expect, test } from "vitest";
import {
  asIdentifier,
  deriveEventStatus,
  failureCategories,
  isTerminalDeliveryState,
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
    deliveryId: id("dlv"),
    eventId: id("evt"),
    tenantId: id("tenant"),
    partnerId: id("ptr"),
    destinationId: id("dst"),
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
      secretReferenceNames: [],
      transformationId: id("trf"),
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
    const token = id("lease");
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
  test("rejects invalid or unleased transitions", () => {
    expect(() =>
      transitionDelivery(delivery(), {
        to: "succeeded",
        at: instant,
        expectedVersion: 1,
      }),
    ).toThrow("Cannot transition");
    const inProgress = { ...delivery("in_progress"), leaseToken: id("lease") };
    expect(() =>
      transitionDelivery(inProgress, {
        to: "failed_terminal",
        at: instant,
        expectedVersion: 1,
        leaseToken: id("other"),
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
  expect(id("evt")).toMatch(/^evt_/);
  expect(() => asIdentifier("evt", "evt_not-a-ulid")).toThrow("ULID");
  expect(
    new FixedClock(new Date("2026-08-13T00:00:00Z")).now().toISOString(),
  ).toBe("2026-08-13T00:00:00.000Z");
  expect(new SequenceRandom([0.25, 0.75]).next()).toBe(0.25);
  expect(new SequenceIdGenerator([ulid]).next("cor")).toBe(`cor_${ulid}`);
});
