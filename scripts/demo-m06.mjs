import { createHash, createHmac, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const issuer =
  process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/pirh-local";
const secret = process.env.LOCAL_SEED_PRODUCER_SECRET;
const controlToken = process.env.MOCK_CONTROL_TOKEN;
const clientId =
  process.env.LOCAL_DEMO_CLIENT_ID ?? "cli_01J0A1B2C3D4E5F6G7H8J9K0MN";
if (secret === undefined || controlToken === undefined)
  throw new Error(
    "LOCAL_SEED_PRODUCER_SECRET and MOCK_CONTROL_TOKEN are required.",
  );

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
async function token(username, password) {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "pirh-console",
    username,
    password,
  });
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const value = await response.json();
  if (!response.ok || typeof value.access_token !== "string")
    throw new Error(`Could not obtain ${username} token.`);
  return value.access_token;
}
async function request(path, tokenValue, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${tokenValue}`,
      ...(options.headers ?? {}),
    },
  });
  return { response, body: await response.json() };
}
async function eventually(work, predicate, label, maxAttempts = 40) {
  let value;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    value = await work();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

const [admin, operator, viewer] = await Promise.all([
  token("admin@example.test", "admin-demo-only"),
  token("operator@example.test", "operator-demo-only"),
  token("viewer@example.test", "viewer-demo-only"),
]);
const forced = await fetch("http://localhost:4012/__control/mode", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mock-control-token": controlToken,
  },
  body: JSON.stringify({ mode: "503" }),
});
if (!forced.ok) throw new Error("Could not force Beta failure.");
const payload = {
  eventType: "shipment.status_changed",
  occurredAt: new Date().toISOString(),
  subject: { type: "shipment", id: `shipment_m06_${Date.now()}` },
  data: {
    status: "in_transit",
    trackingNumber: `TRACK-M06-${Date.now()}`,
    estimatedDelivery: "2026-08-20",
  },
  metadata: { source: "m06-demo" },
};
const raw = Buffer.from(JSON.stringify(payload));
const acceptedResponse = await fetch(`${baseUrl}/api/v1/events`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": randomBytes(18).toString("base64url"),
    ...signedHeaders("POST", "/api/v1/events", raw),
  },
  body: raw,
});
const accepted = await acceptedResponse.json();
if (acceptedResponse.status !== 202)
  throw new Error(`Event submission failed: ${JSON.stringify(accepted)}`);
const found = await eventually(
  async () =>
    request(
      `/api/v1/deliveries?correlationId=${encodeURIComponent(accepted.correlationId)}`,
      operator,
    ),
  (value) =>
    value.response.ok &&
    value.body.items?.some((item) => item.state === "dead_lettered"),
  "Beta delivery did not dead-letter",
  220,
);
const original = found.body.items.find(
  (item) => item.state === "dead_lettered",
);
const eventBefore = await request(
  `/api/v1/events/${accepted.eventId}`,
  operator,
);
const viewerReplay = await request(
  `/api/v1/deliveries/${original.deliveryId}/replays`,
  viewer,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomBytes(18).toString("base64url"),
    },
    body: JSON.stringify({ reason: "viewer must not replay" }),
  },
);
if (viewerReplay.response.status !== 403)
  throw new Error("Viewer replay was not rejected.");
const currentDestination = await request(
  `/api/v1/destinations/${original.destinationId}`,
  admin,
);
if (!currentDestination.response.ok)
  throw new Error(
    `Could not read replay destination: ${JSON.stringify(currentDestination.body)}`,
  );
const updatedDestination = await request(
  `/api/v1/destinations/${original.destinationId}`,
  admin,
  {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "if-match": `"${currentDestination.body.version}"`,
    },
    body: JSON.stringify({
      retryPolicy: { ...currentDestination.body.retryPolicy, maxAttempts: 2 },
    }),
  },
);
if (!updatedDestination.response.ok)
  throw new Error(
    `Could not update replay destination: ${JSON.stringify(updatedDestination.body)}`,
  );
await fetch("http://localhost:4012/__control/mode", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mock-control-token": controlToken,
  },
  body: JSON.stringify({ mode: "success" }),
});
const replay = await request(
  `/api/v1/deliveries/${original.deliveryId}/replays`,
  operator,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomBytes(18).toString("base64url"),
    },
    body: JSON.stringify({
      reason: "Beta endpoint has recovered",
      correctionConfirmed: true,
    }),
  },
);
if (replay.response.status !== 202)
  throw new Error(`Replay was not accepted: ${JSON.stringify(replay.body)}`);
const replayDetail = await eventually(
  async () => request(`/api/v1/deliveries/${replay.body.deliveryId}`, operator),
  (value) => value.response.ok && value.body.delivery?.state === "succeeded",
  "Replay did not succeed",
  180,
);
const eventAfter = await request(
  `/api/v1/events/${accepted.eventId}`,
  operator,
);
if (eventBefore.body.event.status !== eventAfter.body.event.status)
  throw new Error("Replay changed the original event status.");
if (
  replayDetail.body.replayRelations?.[0]?.replayDestinationVersion <=
  replayDetail.body.replayRelations?.[0]?.originalDestinationVersion
)
  throw new Error("Replay did not retain old/new configuration relation.");
console.log(
  JSON.stringify(
    {
      accepted,
      original: original.deliveryId,
      replay: replay.body,
      eventStatus: eventAfter.body.event.status,
    },
    null,
    2,
  ),
);
