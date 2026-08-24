import { createHash, createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  InitiateAuthCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const apiBase = process.env.HOSTED_API_URL;
const consoleOrigin = process.env.HOSTED_CONSOLE_ORIGIN;
const clientId = process.env.COGNITO_CLIENT_ID;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
const alphaUrl = process.env.HOSTED_MOCK_ALPHA_URL;
const betaUrl = process.env.HOSTED_MOCK_BETA_URL;
if (
  apiBase === undefined ||
  consoleOrigin === undefined ||
  clientId === undefined ||
  adminPassword === undefined ||
  alphaUrl === undefined ||
  betaUrl === undefined
)
  throw new Error(
    "Hosted API, console, Cognito, mock URLs, and DEMO_ADMIN_PASSWORD are required.",
  );
const ready = await fetch(`${apiBase.replace(/\/$/, "")}/health/ready`, {
  signal: AbortSignal.timeout(10_000),
});
if (!ready.ok)
  throw new Error(`Hosted API readiness failed with ${ready.status}.`);
const consoleResponse = await fetch(consoleOrigin, {
  signal: AbortSignal.timeout(10_000),
});
if (!consoleResponse.ok)
  throw new Error(
    `Hosted console reachability failed with ${consoleResponse.status}.`,
  );
const region = process.env.AWS_REGION ?? "us-east-1";
const ssm = new SSMClient({ region });
const parameter = async (name) => {
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  if (result.Parameter?.Value === undefined)
    throw new Error(`Required parameter ${name} is unavailable.`);
  return result.Parameter.Value;
};
const [producerSecret, controlToken] = await Promise.all([
  parameter(
    "/pirh/demo/tenants/tenant_01J0A1B2C3D4E5F6G7H8J9K0MN/secrets/producer-current",
  ),
  parameter("/pirh/demo/system/mock-control-token"),
]);
const body = Buffer.from(
  JSON.stringify({
    eventType: "shipment.status_changed",
    occurredAt: new Date().toISOString(),
    subject: { id: `hosted-smoke-${randomUUID()}` },
    data: {
      trackingNumber: "PIRH-HOSTED-SMOKE",
      status: "in_transit",
      estimatedDelivery: "2026-08-25",
    },
  }),
);
const timestamp = String(Math.floor(Date.now() / 1_000));
const nonce = randomUUID();
const path = "/api/v1/events";
const canonical = [
  "POST",
  path,
  timestamp,
  nonce,
  createHash("sha256").update(body).digest("hex"),
].join("\n");
const signature = createHmac("sha256", producerSecret)
  .update(canonical)
  .digest("base64url");
const accepted = await fetch(`${apiBase}${path}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": `hosted-smoke-${randomUUID()}`,
    "x-client-id": "cli_01J0A1B2C3D4E5F6G7H8J9K0MN",
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": signature,
  },
  body,
  signal: AbortSignal.timeout(10_000),
});
if (accepted.status !== 202)
  throw new Error(`Hosted event submission failed with ${accepted.status}.`);
const acceptance = await accepted.json();
if (typeof acceptance.eventId !== "string")
  throw new Error("Hosted event acceptance did not return an event ID.");
const cognito = new CognitoIdentityProviderClient({ region });
const tokenResult = await cognito.send(
  new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: "admin@pirh.demo", PASSWORD: adminPassword },
  }),
);
const accessToken = tokenResult.AuthenticationResult?.AccessToken;
if (accessToken === undefined)
  throw new Error("Hosted Cognito authentication failed.");
const until = Date.now() + 60_000;
let detail;
while (Date.now() < until) {
  const response = await fetch(
    `${apiBase}/api/v1/events/${acceptance.eventId}`,
    {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.ok) {
    const candidate = await response.json();
    if (
      Array.isArray(candidate.deliveries) &&
      candidate.deliveries.length === 2 &&
      candidate.deliveries.every((delivery) => delivery.state === "succeeded")
    ) {
      detail = candidate;
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (detail === undefined)
  throw new Error(
    "Hosted event did not reach both partners before the 60-second deadline.",
  );
const captured = async (url) => {
  const response = await fetch(`${url}__control/captures`, {
    headers: { "x-mock-control-token": controlToken },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Mock capture inspection failed with ${response.status}.`);
  return response.json();
};
const [alpha, beta] = await Promise.all([
  captured(alphaUrl),
  captured(betaUrl),
]);
const containsEvent = (value) =>
  JSON.stringify(value).includes(acceptance.eventId);
if (!containsEvent(alpha) || !containsEvent(beta))
  throw new Error("Hosted mock capture evidence is incomplete.");
console.log(
  JSON.stringify({
    api: "ready",
    console: "reachable",
    eventId: acceptance.eventId,
    deliveries: detail.deliveries.length,
    mocks: "captured",
    consoleSession: "authenticated",
  }),
);
