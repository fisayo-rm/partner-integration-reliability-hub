import { expect, test } from "vitest";
import {
  executeTransformation,
  TransformationError,
} from "../../packages/transformation/src/index.js";

const event = {
  eventId: "evt_01J0A1B2C3D4E5F6G7H8J9K0MN",
  occurredAt: "2026-08-17T12:00:00.000Z",
  subject: { id: "shipment_1" },
  data: { trackingNumber: "TRACK-1", status: "in_transit", date: "2026-08-20" },
};
test("the declarative transformation runtime supports the bounded v1 operations deterministically", () => {
  const definition = {
    schemaVersion: 1,
    contentType: "application/json",
    mappings: [
      { target: "$.id", source: "$.subject.id", required: true },
      { target: "$.status", source: "$.data.status", transform: "UPPER_SNAKE" },
      { target: "$.date", source: "$.data.date", transform: "ISO_DATE" },
      {
        target: "$.compound",
        transform: "CONCAT",
        parts: [{ literal: "ref-" }, { source: "$.data.trackingNumber" }],
      },
      {
        target: "$.mapped",
        source: "$.data.status",
        transform: "ENUM_MAP",
        values: { in_transit: "MOVING" },
      },
    ],
  };
  const first = executeTransformation(definition, event);
  const second = executeTransformation(definition, event);
  expect(first.output).toMatchObject({
    id: "shipment_1",
    status: "IN_TRANSIT",
    date: "2026-08-20",
    compound: "ref-TRACK-1",
    mapped: "MOVING",
  });
  expect(first.serialized).toBe(second.serialized);
  expect(first.hash).toBe(second.hash);
});
test("transformations reject missing requirements, conflicts, and unsafe operations", () => {
  expect(() =>
    executeTransformation(
      {
        schemaVersion: 1,
        contentType: "application/json",
        mappings: [{ target: "$.a", source: "$.none", required: true }],
      },
      event,
    ),
  ).toThrow(TransformationError);
  expect(() =>
    executeTransformation(
      {
        schemaVersion: 1,
        contentType: "application/json",
        mappings: [
          { target: "$.a", literal: "x" },
          { target: "$.a.b", literal: "x" },
        ],
      },
      event,
    ),
  ).toThrow();
  expect(() =>
    executeTransformation(
      {
        schemaVersion: 1,
        contentType: "application/json",
        mappings: [
          {
            target: "$.a",
            source: "$.data.status",
            transform: "ENUM_MAP",
            values: {},
          },
        ],
      },
      event,
    ),
  ).toThrow(TransformationError);
});
