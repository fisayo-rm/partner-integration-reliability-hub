import { describe, expect, test } from "vitest";
import { replayEligibility } from "../../packages/domain/src/index.js";
import { redactedJson } from "../../packages/application/src/index.js";
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
