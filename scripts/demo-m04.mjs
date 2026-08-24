import { createHash, createHmac, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const clientId =
  process.env.LOCAL_DEMO_CLIENT_ID ?? "cli_01J0A1B2C3D4E5F6G7H8J9K0MN";
const secret = process.env.LOCAL_SEED_PRODUCER_SECRET;
const controlToken = process.env.MOCK_CONTROL_TOKEN;
if (secret === undefined)
  throw new Error("LOCAL_SEED_PRODUCER_SECRET is required.");

function signedHeaders(method, path, body = Buffer.alloc(0)) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const canonical = [
    method,
    path,
    timestamp,
    nonce,
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  return {
    "x-client-id": clientId,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": createHmac("sha256", secret)
      .update(canonical)
      .digest("base64url"),
  };
}
const payload = {
  eventType: "shipment.status_changed",
  occurredAt: new Date().toISOString(),
  subject: { type: "shipment", id: "shipment_m04_demo" },
  data: {
    status: "in_transit",
    trackingNumber: `TRACK-M04-${Date.now()}`,
    estimatedDelivery: "2026-08-20",
  },
  metadata: { source: "m04-demo" },
};
const body = Buffer.from(JSON.stringify(payload));
const idempotencyKey = randomBytes(18).toString("base64url");
const acceptedResponse = await fetch(`${baseUrl}/api/v1/events`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    ...signedHeaders("POST", "/api/v1/events", body),
  },
  body,
});
const accepted = await acceptedResponse.json();
if (acceptedResponse.status !== 202)
  throw new Error(`Event submission failed: ${JSON.stringify(accepted)}`);
const duplicateResponse = await fetch(`${baseUrl}/api/v1/events`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    ...signedHeaders("POST", "/api/v1/events", body),
  },
  body,
});
const duplicate = await duplicateResponse.json();
if (
  duplicateResponse.status !== 200 ||
  duplicate.eventId !== accepted.eventId ||
  duplicate.correlationId !== accepted.correlationId
)
  throw new Error(`Duplicate submission failed: ${JSON.stringify(duplicate)}`);
let status;
let lastStatus = "not queried";
const deliveryDeadline = Date.now() + 60_000;
while (Date.now() < deliveryDeadline) {
  const path = `/api/v1/events/${accepted.eventId}`;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: signedHeaders("GET", path),
  });
  status = await response.json();
  lastStatus = JSON.stringify(status);
  if (response.ok && status.status === "succeeded") break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (status?.status !== "succeeded")
  throw new Error(
    `Delivery did not succeed within the 60s policy-aware deadline: ${lastStatus}`,
  );
let partnerOutcomes = "not checked";
if (controlToken !== undefined) {
  const captures = await Promise.all(
    ["http://localhost:4011", "http://localhost:4012"].map(async (url) => {
      const response = await fetch(`${url}/__control/captures`, {
        headers: { "x-mock-control-token": controlToken },
      });
      const value = await response.json();
      return Array.isArray(value.items)
        ? value.items.some(
            (item) =>
              item.headers?.["x-correlation-id"] === accepted.correlationId,
          )
        : false;
    }),
  );
  if (!captures.every(Boolean))
    throw new Error("Partner captures are incomplete.");
  partnerOutcomes =
    "Alpha and Beta captured the correlated transformed delivery";
}
console.log(
  JSON.stringify(
    {
      accepted,
      duplicate,
      finalStatus: status,
      partnerOutcomes,
    },
    null,
    2,
  ),
);
