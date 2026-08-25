import { createHash, createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { URL, URLSearchParams } from "node:url";
import {
  InitiateAuthCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { chromium } from "@playwright/test";

const apiBase = process.env.HOSTED_API_URL;
const consoleOrigin = process.env.HOSTED_CONSOLE_ORIGIN;
const clientId = process.env.COGNITO_CLIENT_ID;
const issuer = process.env.OIDC_ISSUER;
const hostedLoginAuthority = process.env.VITE_OIDC_HOSTED_LOGIN_AUTHORITY;
const adminPassword = process.env.DEMO_ADMIN_PASSWORD;
const alphaUrl = process.env.HOSTED_MOCK_ALPHA_URL;
const betaUrl = process.env.HOSTED_MOCK_BETA_URL;
if (
  apiBase === undefined ||
  consoleOrigin === undefined ||
  clientId === undefined ||
  issuer === undefined ||
  hostedLoginAuthority === undefined ||
  adminPassword === undefined ||
  alphaUrl === undefined ||
  betaUrl === undefined
)
  throw new Error(
    "Hosted API, console, Cognito hosted-login authority, mock URLs, and DEMO_ADMIN_PASSWORD are required.",
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
const hostedAuthorize = new URL(
  `${hostedLoginAuthority.replace(/\/$/, "")}/oauth2/authorize`,
);
hostedAuthorize.search = new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  scope: "openid profile email",
  redirect_uri: `${consoleOrigin.replace(/\/$/, "")}/auth/callback`,
  state: randomUUID(),
  nonce: randomUUID(),
}).toString();
const hostedLogin = await fetch(hostedAuthorize, {
  redirect: "manual",
  signal: AbortSignal.timeout(10_000),
});
const hostedLoginLocation = hostedLogin.headers.get("location") ?? "";
if (
  !hostedLogin.ok &&
  (hostedLogin.status !== 302 ||
    !hostedLoginLocation.startsWith(`${hostedLoginAuthority}/login`))
)
  throw new Error(
    `Hosted Cognito authorization endpoint failed with ${hostedLogin.status}.`,
  );
const hostedLoginPage = await fetch(hostedLoginLocation, {
  redirect: "manual",
  signal: AbortSignal.timeout(10_000),
});
if (!hostedLoginPage.ok)
  throw new Error(
    `Hosted Cognito login page failed with ${hostedLoginPage.status}.`,
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
    subject: { type: "shipment", id: `hosted-smoke-${randomUUID()}` },
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
const hostedSession = await fetch(`${apiBase}/api/v1/session`, {
  headers: { authorization: `Bearer ${accessToken}` },
  signal: AbortSignal.timeout(10_000),
});
if (!hostedSession.ok)
  throw new Error(
    `Hosted console session authorization failed with ${hostedSession.status}.`,
  );
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
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(
    ({ authority, audience, token }) => {
      globalThis.sessionStorage.setItem(
        `oidc.user:${authority}:${audience}`,
        JSON.stringify({
          access_token: token,
          token_type: "Bearer",
          profile: { sub: "hosted-smoke", "cognito:groups": ["admin"] },
          expires_at: Math.floor(Date.now() / 1_000) + 300,
        }),
      );
    },
    { authority: issuer, audience: clientId, token: accessToken },
  );
  await page.goto(
    `${consoleOrigin.replace(/\/$/, "")}/events/${acceptance.eventId}`,
    {
      waitUntil: "networkidle",
      timeout: 20_000,
    },
  );
  try {
    await page.getByRole("heading", { name: "Event detail" }).waitFor();
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: globalThis.location.href,
      storageKeys: Object.keys(globalThis.sessionStorage),
      text: globalThis.document.body.innerText.slice(0, 500),
    }));
    throw new Error(
      `Hosted console did not render the event detail: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
  await page.getByText(acceptance.eventId, { exact: true }).waitFor();
  if ((await page.getByText("succeeded", { exact: true }).count()) < 2)
    throw new Error(
      "Hosted console did not display both successful deliveries.",
    );
} finally {
  await browser.close();
}
console.log(
  JSON.stringify({
    api: "ready",
    consoleReachability: "reachable",
    eventId: acceptance.eventId,
    deliveries: detail.deliveries.length,
    mocks: "captured",
    console: "authenticated-event-visible",
  }),
);
