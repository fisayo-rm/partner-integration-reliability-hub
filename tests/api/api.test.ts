import { expect, test } from "vitest";
import { buildApi } from "../../apps/api/src/app.js";
import { ReplayService } from "../../packages/application/src/index.js";

const ready = async (name: string) => ({ name, ok: true });
test("shared API exposes health, metadata, and OpenAPI skeleton", async () => {
  const app = await buildApi({
    requiredConfiguration: () => ready("configuration"),
    dynamoDb: () => ready("dynamodb"),
    elasticMq: () => ready("elasticmq"),
  });
  try {
    expect((await app.inject("/health/live")).statusCode).toBe(200);
    expect((await app.inject("/health/ready")).json().status).toBe("ready");
    expect((await app.inject("/api/v1/meta")).json().mode).toBe("skeleton");
    expect((await app.inject("/openapi.json")).json().openapi).toBe("3.1.0");
  } finally {
    await app.close();
  }
});
test("readiness is bounded by injected dependency probes", async () => {
  const app = await buildApi({
    requiredConfiguration: () => ready("configuration"),
    dynamoDb: () => ready("dynamodb"),
    elasticMq: async () => ({
      name: "elasticmq",
      ok: false,
      detail: "unreachable",
    }),
  });
  try {
    const response = await app.inject("/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: [
        { name: "configuration", status: "up" },
        { name: "dynamodb", status: "up" },
        { name: "elasticmq", status: "down" },
      ],
    });
    expect(response.body).not.toContain("unreachable");
  } finally {
    await app.close();
  }
});

test("M06 exposes tenant-authenticated search and rejects viewer replay", async () => {
  const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never;
  const context = {
    tenantId,
    actorType: "console_user" as const,
    actorId: "viewer",
    role: "viewer" as const,
    requestId: "req_01J0A1B2C3D4E5F6G7H8J9K0MN",
    correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
  };
  const repository = {
    searchEvents: async () => ({ items: [] }),
    searchDeliveries: async () => ({ items: [] }),
    getEventDetail: async () => undefined,
    getDeliveryDetail: async () => undefined,
    listAudit: async () => ({ items: [] }),
    getRollups: async () => [],
    countDeliveriesByState: async () => 0,
    listDestinations: async () => ({ items: [] }),
    getCircuitState: async () => ({ state: "CLOSED", version: 0 }),
    createReplay: async () => ({ kind: "conflict" as const }),
  };
  const app = await buildApi({
    requiredConfiguration: () => ready("configuration"),
    dynamoDb: () => ready("dynamodb"),
    elasticMq: () => ready("elasticmq"),
    operations: {
      repository: repository as never,
      service: new ReplayService({
        core: {
          getEvent: async () => undefined,
          getDelivery: async () => undefined,
          getDestination: async () => undefined,
          getPartner: async () => undefined,
          listSubscriptions: async () => [],
          getTransformationVersion: async () => undefined,
        },
        repository: repository as never,
        execute: () => ({ output: {}, hash: "hash" }),
        ids: { next: () => "req_01J0A1B2C3D4E5F6G7H8J9K0MN" },
        clock: { now: () => new Date("2026-08-18T00:00:00.000Z") },
        retentionDays: 30,
      }),
      consoleAuthenticator: { authenticate: async () => context } as never,
      cursorSecret: "test-cursor-secret",
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    },
  });
  try {
    const headers = { authorization: "Bearer test" };
    expect(
      (await app.inject({ url: "/api/v1/events", headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/session", headers })).json(),
    ).toEqual({ actorId: "viewer", tenantId, role: "viewer" });
    expect(
      (
        await app.inject({
          url: "/api/v1/events/evt_01J0A1B2C3D4E5F6G7H8J9K0MN",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: "/api/v1/deliveries", headers })).statusCode,
    ).toBe(200);
    const missingDelivery = await app.inject({
      url: "/api/v1/deliveries/dlv_01J0A1B2C3D4E5F6G7H8J9K0MN",
      headers,
    });
    expect(missingDelivery.statusCode).toBe(404);
    expect(missingDelivery.json().error).toMatchObject({
      code: "NOT_FOUND",
      requestId: expect.any(String),
      correlationId: expect.stringMatching(/^cor_/),
    });
    expect(
      (await app.inject({ url: "/api/v1/audit-logs", headers })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v1/operational-rollups",
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/deliveries/dlv_01J0A1B2C3D4E5F6G7H8J9K0MN/replays",
          headers: { ...headers, "idempotency-key": "replay-key" },
          payload: { reason: "credentials were corrected" },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
