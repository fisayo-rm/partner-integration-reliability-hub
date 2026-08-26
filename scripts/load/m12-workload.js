import crypto from "k6/crypto";
import http from "k6/http";
import { check } from "k6";

const baseUrl = __ENV.PIRH_LOAD_BASE_URL || "http://api:3000";
const clientId = __ENV.LOCAL_DEMO_CLIENT_ID || "cli_01J0A1B2C3D4E5F6G7H8J9K0MN";
const secret = __ENV.LOCAL_SEED_PRODUCER_SECRET;
if (!secret) throw new Error("LOCAL_SEED_PRODUCER_SECRET is required");
const scenario = __ENV.K6_SCENARIO || "one-destination";
const rate = Number(__ENV.K6_RATE || 100);
const duration = __ENV.K6_DURATION || "60s";

export const options = {
  scenarios: {
    arrivals: {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs: Number(__ENV.K6_PREALLOCATED_VUS || 100),
      maxVUs: Number(__ENV.K6_MAX_VUS || 500),
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<300"],
  },
};
function nonce(iteration) {
  return crypto.hmac(
    "sha256",
    secret,
    `${__VU}:${iteration}:${Date.now()}`,
    "base64url",
  );
}
function headers(body, iteration) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const value = nonce(iteration);
  const digest = crypto.sha256(body, "hex");
  const signature = crypto.hmac(
    "sha256",
    secret,
    `POST\n/api/v1/events\n${timestamp}\n${value}\n${digest}`,
    "base64url",
  );
  return {
    "content-type": "application/json",
    "x-client-id": clientId,
    "x-timestamp": timestamp,
    "x-nonce": value,
    "x-signature": signature,
    "idempotency-key": `m12-${scenario}-${__VU}-${iteration}-${Date.now()}`,
  };
}
export default function () {
  const payload = JSON.stringify({
    eventType: "shipment.status_changed",
    occurredAt: new Date().toISOString(),
    subject: { type: "shipment", id: `m12-${scenario}-${__VU}-${__ITER}` },
    data: { status: "in_transit", loadScenario: scenario, sequence: __ITER },
    metadata: { source: "m12-k6" },
  });
  const response = http.post(`${baseUrl}/api/v1/events`, payload, {
    headers: headers(payload, __ITER),
    tags: { scenario },
  });
  check(response, { "event accepted": (value) => value.status === 202 });
}
