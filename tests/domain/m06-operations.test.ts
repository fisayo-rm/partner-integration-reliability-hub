import { describe, expect, test } from "vitest";
import { replayEligibility } from "../../packages/domain/src/index.js";
import { redactedJson } from "../../packages/application/src/index.js";
import { rollupUpdates } from "../../packages/persistence/src/index.js";
import {
  replayRequestSchema,
  replayResponseSchema,
} from "../../packages/contracts/src/index.js";

describe("M06 replay policy", () => {
  test("permits dead letters and correction-confirmed operator-correctable terminal failures", () => {
    expect(
      replayEligibility({ state: "dead_lettered", correctionConfirmed: false }),
    ).toEqual({ eligible: true, requiresCorrection: false });
    expect(
      replayEligibility({
        state: "failed_terminal",
        failureCategory: "OAUTH_TOKEN_ERROR",
        correctionConfirmed: false,
      }),
    ).toEqual({ eligible: false, requiresCorrection: true });
    expect(
      replayEligibility({
        state: "failed_terminal",
        failureCategory: "OAUTH_TOKEN_ERROR",
        correctionConfirmed: true,
      }),
    ).toEqual({ eligible: true, requiresCorrection: true });
    expect(
      replayEligibility({
        state: "failed_terminal",
        failureCategory: "UNKNOWN",
        correctionConfirmed: true,
      }).eligible,
    ).toBe(false);
  });
});

test("M06 redacts a cloned transformed payload and keeps strict replay contracts", () => {
  const source = { partner: { token: "secret", safe: "value" } };
  expect(redactedJson(source, ["$.partner.token"])).toEqual({
    partner: { token: "[REDACTED]", safe: "value" },
  });
  expect(source.partner.token).toBe("secret");
  expect(
    replayRequestSchema.safeParse({ reason: "credential was rotated" }).success,
  ).toBe(true);
  expect(replayRequestSchema.safeParse({ reason: "short" }).success).toBe(
    false,
  );
  expect(
    replayResponseSchema.safeParse({
      replayId: "rpl_01J0A1B2C3D4E5F6G7H8J9K0MN",
      deliveryId: "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN",
      originalDeliveryId: "dlv_11J0A1B2C3D4E5F6G7H8J9K0MN",
      state: "scheduled",
      previouslyAccepted: false,
    }).success,
  ).toBe(true);
});

test("M08 keeps replay attempt outcomes out of original delivery rollups", () => {
  const updates = rollupUpdates({
    tableName: "core",
    tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
    destinationId: "dst_01J0A1B2C3D4E5F6G7H8J9K0MN",
    stableId: "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN",
    at: "2026-08-18T00:00:00.000Z",
    attempt: {
      attemptId: "att_01J0A1B2C3D4E5F6G7H8J9K0MN",
      deliveryId: "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN",
      tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN",
      attemptNumber: 1,
      outcome: "succeeded",
      startedAt: "2026-08-18T00:00:00.000Z",
      completedAt: "2026-08-18T00:00:00.100Z",
      durationMs: 100,
      createdAt: "2026-08-18T00:00:00.000Z",
    } as never,
    delivery: {
      deliveryId: "dlv_01J0A1B2C3D4E5F6G7H8J9K0MN",
      tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN",
      eventId: "evt_01J0A1B2C3D4E5F6G7H8J9K0MN",
      correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN",
      partnerId: "par_01J0A1B2C3D4E5F6G7H8J9K0MN",
      destinationId: "dst_01J0A1B2C3D4E5F6G7H8J9K0MN",
      state: "succeeded",
      executionType: "REPLAY",
      attemptCount: 1,
      maxAttempts: 5,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.100Z",
      configSnapshot: {} as never,
      transformedPayload: {},
    } as never,
  });
  const values = (
    updates[0] as {
      Update: { ExpressionAttributeValues: Record<string, number> };
    }
  ).Update.ExpressionAttributeValues;
  expect(values).toMatchObject({
    ":attempt": 0,
    ":success": 0,
    ":failure": 0,
    ":retry": 0,
    ":dead": 0,
    ":replaySuccess": 1,
    ":replayFailure": 0,
    ":latency": 0,
    ":latencyCount": 0,
  });
});
