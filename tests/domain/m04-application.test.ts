import { expect, test } from "vitest";
import {
  canonicalJsonHash,
  deterministicIdentifier,
} from "../../packages/application/src/index.js";
import { routeEventMessageSchema } from "../../packages/contracts/src/index.js";

test("M04 canonical request hashes are independent of JSON object key order", () => {
  expect(canonicalJsonHash({ b: { y: 2, x: 1 }, a: "value" })).toBe(
    canonicalJsonHash({ a: "value", b: { x: 1, y: 2 } }),
  );
});

test("M04 deterministic delivery identifiers are stable and destination-specific", () => {
  const first = deterministicIdentifier(
    "dlv",
    "tenant\nevent\ndestination-a\nORIGINAL",
  );
  expect(first).toBe(
    deterministicIdentifier("dlv", "tenant\nevent\ndestination-a\nORIGINAL"),
  );
  expect(first).not.toBe(
    deterministicIdentifier("dlv", "tenant\nevent\ndestination-b\nORIGINAL"),
  );
});

test("M04 route messages reject canonical payload-bearing bodies", () => {
  expect(() =>
    routeEventMessageSchema.parse({
      schemaVersion: 1,
      messageType: "ROUTE_EVENT",
      tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN",
      eventId: "evt_01J0A1B2C3D4E5F6G7H8J9K0MN",
      correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN",
      cause: "INITIAL",
      payload: { secret: "not-permitted" },
    }),
  ).toThrow();
});
