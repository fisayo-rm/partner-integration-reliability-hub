import crypto from "k6/crypto";
import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const baseUrl = __ENV.PIRH_LOAD_BASE_URL || "http://api:3000";
const clientId = __ENV.LOCAL_DEMO_CLIENT_ID || "cli_01J0A1B2C3D4E5F6G7H8J9K0MN";
const secret = __ENV.LOCAL_SEED_PRODUCER_SECRET;
if (!secret) throw new Error("LOCAL_SEED_PRODUCER_SECRET is required");
const scenario = __ENV.PIRH_LOAD_SCENARIO || "one-destination";
const rate = Number(__ENV.PIRH_K6_RATE || 100);
const duration = __ENV.PIRH_K6_DURATION || "60s";
const warmupDuration = __ENV.PIRH_K6_WARMUP_DURATION || "10s";
const durationSeconds = Number.parseInt(duration, 10);
if (!Number.isSafeInteger(durationSeconds) || !duration.endsWith("s"))
  throw new Error("PIRH_K6_DURATION must be a whole number of seconds.");
if (!/^\d+s$/.test(warmupDuration))
  throw new Error("PIRH_K6_WARMUP_DURATION must be a whole number of seconds.");
const acceptedEvents = new Counter("accepted_events");
const ingestionRetries = new Counter("ingestion_retries");
const ingestionRequestFailure = new Rate("ingestion_request_failure");
const ingestionAcceptDuration = new Trend("ingestion_accept_duration");

export const options = {
  scenarios: {
    warmup: {
      executor: "constant-arrival-rate",
      exec: "warmup",
      rate: Math.min(rate, 20),
      timeUnit: "1s",
      duration: warmupDuration,
      preAllocatedVUs: 40,
      maxVUs: 100,
    },
    arrivals: {
      executor: "constant-arrival-rate",
      exec: "benchmark",
      rate,
      timeUnit: "1s",
      duration,
      startTime: warmupDuration,
      preAllocatedVUs: Number(__ENV.PIRH_K6_PREALLOCATED_VUS || 120),
      maxVUs: Number(__ENV.PIRH_K6_MAX_VUS || 300),
    },
  },
  thresholds: {
    dropped_iterations: ["count==0"],
    "ingestion_request_failure{phase:benchmark}": ["rate<0.01"],
    "ingestion_accept_duration{phase:benchmark}": ["p(95)<300"],
    accepted_events: [`count>=${rate * durationSeconds}`],
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
function headers(body, iteration, idempotencyKey) {
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
    "idempotency-key": idempotencyKey,
  };
}
function submit(benchmark) {
  const started = Date.now();
  const payload = JSON.stringify({
    eventType: "shipment.status_changed",
    occurredAt: new Date().toISOString(),
    subject: { type: "shipment", id: `m12-${scenario}-${__VU}-${__ITER}` },
    data: { status: "in_transit", loadScenario: scenario, sequence: __ITER },
    metadata: { source: "m12-k6" },
  });
  const idempotencyKey = `m12-${scenario}-${__VU}-${__ITER}-${Date.now()}`;
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = http.post(`${baseUrl}/api/v1/events`, payload, {
      headers: headers(payload, __ITER, idempotencyKey),
      tags: { scenario, phase: benchmark ? "benchmark" : "warmup" },
    });
    if (response.status === 202 || response.status === 200) break;
    if (benchmark) ingestionRetries.add(1);
  }
  const accepted = response.status === 202 || response.status === 200;
  if (!benchmark) return;
  ingestionRequestFailure.add(accepted ? 0 : 1, { phase: "benchmark" });
  if (
    check(response, {
      "event accepted": (value) => value.status === 202 || value.status === 200,
    })
  ) {
    acceptedEvents.add(1);
    ingestionAcceptDuration.add(Date.now() - started, { phase: "benchmark" });
  }
}
export function warmup() {
  submit(false);
}
export function benchmark() {
  submit(true);
}

export function handleSummary(data) {
  const metrics = Object.fromEntries(
    Object.entries(data.metrics).map(([name, value]) => [name, value.values]),
  );
  const summary = {
    version: 1,
    scenario,
    rate,
    duration,
    warmupDuration,
    requiredAcceptedEvents: rate * durationSeconds,
    benchmarkAcceptedEvents: metrics.accepted_events?.count ?? 0,
    benchmarkAcceptedRate:
      (metrics.accepted_events?.count ?? 0) / durationSeconds,
    metrics,
  };
  const serialized = JSON.stringify(summary, null, 2);
  const output = { stdout: `PIRH_K6_SUMMARY=${JSON.stringify(summary)}\n` };
  if (__ENV.K6_SUMMARY_EXPORT) output[__ENV.K6_SUMMARY_EXPORT] = serialized;
  return output;
}
