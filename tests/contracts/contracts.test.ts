import { expect, test } from "vitest";
import {
  canonicalEventRequestSchema,
  partnerAlphaPayloadSchema,
  partnerBetaPayloadSchema,
  paginationCursorPayloadSchema,
  queueMessageSchema,
  transformationDefinitionSchema,
} from "../../packages/contracts/src/index.js";

const ulid = "01J0A1B2C3D4E5F6G7H8J9K0MN";
const id = (prefix: string) => `${prefix}_${ulid}`;
test("canonical requests and partner payloads are strict and test-loadable", () => {
  expect(
    canonicalEventRequestSchema.parse({
      eventType: "shipment.status_changed",
      occurredAt: "2026-08-13T12:00:00.000Z",
      subject: { type: "shipment", id: "shipment_123" },
      data: { status: "in_transit" },
    }).eventType,
  ).toBe("shipment.status_changed");
  expect(
    canonicalEventRequestSchema.safeParse({
      eventId: id("evt"),
      eventType: "shipment.status_changed",
      occurredAt: "2026-08-13T12:00:00.000Z",
      subject: { type: "shipment", id: "x" },
      data: {},
    }).success,
  ).toBe(false);
  expect(
    partnerAlphaPayloadSchema.parse({
      tracking_number: "TRACK-1",
      delivery_status: "IN_TRANSIT",
      event_reference: id("evt"),
    }).tracking_number,
  ).toBe("TRACK-1");
  expect(
    partnerBetaPayloadSchema.parse({
      shipment: {
        id: "shipment_123",
        tracking: { number: "TRACK-1" },
        currentState: "MOVING",
      },
      sourceEvent: { id: id("evt"), occurredAt: "2026-08-13T12:00:00.000Z" },
    }).shipment.id,
  ).toBe("shipment_123");
});
test("queue v1 messages reject unsupported versions and payload-bearing envelopes", () => {
  const message = {
    schemaVersion: 1,
    messageType: "DELIVER",
    tenantId: id("tenant"),
    eventId: id("evt"),
    deliveryId: id("dlv"),
    correlationId: id("cor"),
    cause: "INITIAL",
  };
  expect(queueMessageSchema.parse(message).messageType).toBe("DELIVER");
  expect(
    queueMessageSchema.safeParse({ ...message, schemaVersion: 2 }).success,
  ).toBe(false);
  expect(
    queueMessageSchema.safeParse({ ...message, payload: { secret: "no" } })
      .success,
  ).toBe(false);
});
test("transformation and cursor contracts validate stable shapes", () => {
  expect(
    transformationDefinitionSchema.parse({
      schemaVersion: 1,
      contentType: "application/json",
      mappings: [
        {
          target: "$.tracking_number",
          source: "$.data.trackingNumber",
          required: true,
        },
      ],
    }).mappings,
  ).toHaveLength(1);
  expect(
    transformationDefinitionSchema.safeParse({
      schemaVersion: 1,
      contentType: "application/json",
      mappings: [{ target: "$.x" }],
    }).success,
  ).toBe(false);
  expect(
    paginationCursorPayloadSchema.parse({
      tenantId: id("tenant"),
      endpointFingerprint: "a".repeat(16),
      lastEvaluatedKey: {},
      expiresAt: "2026-08-13T12:00:00.000Z",
    }).tenantId,
  ).toBe(id("tenant"));
});
