import { expect, test } from "vitest";
import { buildMockPartnerAlpha } from "../../apps/mock-partner-alpha/src/index.js";
import { buildMockPartnerBeta } from "../../apps/mock-partner-beta/src/index.js";

const alphaBody = {
  tracking_number: "T",
  delivery_status: "IN_TRANSIT",
  event_reference: "evt_01J0A1B2C3D4E5F6G7H8J9K0MN",
};
test("mock Alpha authenticates and implements native idempotency without capturing its credential", async () => {
  const app = buildMockPartnerAlpha({
    apiKey: "secret",
    controlToken: "control",
  });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/shipments",
          payload: alphaBody,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/shipments",
          payload: alphaBody,
          headers: { "x-api-key": "secret", "idempotency-key": "same" },
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/webhooks/shipments",
          payload: alphaBody,
          headers: { "x-api-key": "secret", "idempotency-key": "same" },
        })
      ).json().duplicate,
    ).toBe(true);
    expect(
      JSON.stringify(
        (
          await app.inject({
            url: "/__control/captures",
            headers: { "x-mock-control-token": "control" },
          })
        ).json(),
      ),
    ).not.toContain("secret");
  } finally {
    await app.close();
  }
});
test("mock Beta accepts standard form-encoded OAuth and intentionally does not deduplicate delivery keys", async () => {
  const app = buildMockPartnerBeta({
    clientId: "client",
    clientSecret: "secret",
    controlToken: "control",
  });
  try {
    const token = (
      await app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: "grant_type=client_credentials",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from("client:secret").toString("base64")}`,
        },
      })
    ).json().access_token as string;
    const body = {
      shipment: { id: "s", tracking: { number: "T" }, currentState: "MOVING" },
      sourceEvent: {
        id: "evt_01J0A1B2C3D4E5F6G7H8J9K0MN",
        occurredAt: "2026-08-17T00:00:00.000Z",
      },
    };
    for (const ignored of [1, 2]) {
      void ignored;
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/shipments",
            payload: body,
            headers: {
              authorization: `Bearer ${token}`,
              "x-delivery-key": "same",
            },
          })
        ).statusCode,
      ).toBe(202);
    }
    expect(
      (
        await app.inject({
          url: "/__control/captures",
          headers: { "x-mock-control-token": "control" },
        })
      ).json().items,
    ).toHaveLength(2);
  } finally {
    await app.close();
  }
});
