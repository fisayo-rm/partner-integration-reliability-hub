import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  DynamoDBClient,
  DescribeTableCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { spawn } from "node:child_process";
import { loadHybridRuntimeEnvironment } from "./hybrid-environment.mjs";

const { environment, outputs } = await loadHybridRuntimeEnvironment();
const requiredOutput = (name) => {
  const value = outputs.get(name);
  if (value === undefined) throw new Error(`${name} output is unavailable.`);
  return value;
};
const secret = () => randomBytes(32).toString("base64url");
const producerSecret = secret();
const alphaApiKey = secret();
const controlToken = secret();

function safeChildFailure(entry, code, stderr, env) {
  const redacted = Object.entries(env)
    .filter(
      ([name, value]) =>
        /(?:SECRET|TOKEN|PASSWORD|ACCESS_KEY|SESSION|API_KEY)/i.test(name) &&
        typeof value === "string" &&
        value.length > 0,
    )
    .reduce(
      (value, [, secretValue]) => value.replaceAll(secretValue, "[redacted]"),
      stderr.slice(-2_000),
    );
  return new Error(`${entry} exited ${code}: ${redacted}`);
}
function runCaptured(entry, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(safeChildFailure(entry, code, stderr, env));
    });
  });
}
function start(entry, env) {
  return spawn(process.execPath, [entry], { env, stdio: "inherit" });
}
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    let forcedTimeout;
    const finish = () => {
      globalThis.clearTimeout(gracefulTimeout);
      globalThis.clearTimeout(forcedTimeout);
      resolve();
    };
    const gracefulTimeout = setTimeout(() => {
      child.kill("SIGKILL");
      forcedTimeout = setTimeout(finish, 2_000);
    }, 10_000);
    child.once("exit", () => {
      finish();
    });
    child.kill("SIGTERM");
  });
}
async function waitFor(url, test, headers) {
  const deadline = Date.now() + 45_000;
  let last = "unavailable";
  while (Date.now() < deadline) {
    try {
      const resolvedHeaders =
        typeof headers === "function" ? headers() : headers;
      const response = await fetch(url, {
        ...(resolvedHeaders === undefined ? {} : { headers: resolvedHeaders }),
        signal: AbortSignal.timeout(3_000),
      });
      last = String(response.status);
      if (await test(response)) return;
    } catch {
      last = "unavailable";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Hybrid service did not become ready (${last}).`);
}
async function waitForValue(test, description) {
  const deadline = Date.now() + 45_000;
  let last = "unavailable";
  while (Date.now() < deadline) {
    const result = await test();
    if (result === true) return;
    last = typeof result === "string" ? result : "not-ready";
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Hybrid ${description} is unavailable (${last}).`);
}
async function denied(action) {
  try {
    await action();
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error ? error.name : "";
    if (String(name).includes("AccessDenied")) return;
  }
  throw new Error("Expected shared-environment access to be denied.");
}
function signedHeaders(method, path, body = Buffer.alloc(0)) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomUUID();
  return {
    "x-client-id": seed.clientId,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": createHmac("sha256", producerSecret)
      .update(
        [
          method,
          path,
          timestamp,
          nonce,
          createHash("sha256").update(body).digest("hex"),
        ].join("\n"),
      )
      .digest("base64url"),
  };
}

const seedOutput = await runCaptured("scripts/seed-hybrid.mjs", {
  ...environment,
  HYBRID_MOCK_ALPHA_URL: environment.MOCK_ALPHA_URL,
  PIRH_HYBRID_SMOKE_PRODUCER_SECRET: producerSecret,
  PIRH_HYBRID_SMOKE_ALPHA_API_KEY: alphaApiKey,
  PIRH_HYBRID_SMOKE_CONTROL_TOKEN: controlToken,
});
const seedLine = seedOutput
  .trim()
  .split("\n")
  .findLast((value) => value.startsWith("{"));
if (seedLine === undefined)
  throw new Error("Hybrid smoke seed output is unavailable.");
const seed = JSON.parse(seedLine);
if (typeof seed.clientId !== "string")
  throw new Error("Hybrid smoke seed is invalid.");
const mockHealth = await fetch(
  `${requiredOutput("MockAlphaUrl")}partner/health`,
  {
    headers: { "x-api-key": alphaApiKey },
    signal: AbortSignal.timeout(10_000),
  },
);
if (!mockHealth.ok)
  throw new Error(
    "Hybrid mock partner did not accept its test-only credential.",
  );

const apiPort = "3100";
const runtimeEnvironment = { ...environment, API_PORT: apiPort };
const processes = [
  start("apps/api/dist/server.js", runtimeEnvironment),
  start("apps/outbox-worker/dist/index.js", runtimeEnvironment),
  start("apps/router-worker/dist/index.js", runtimeEnvironment),
  start("apps/delivery-worker/dist/index.js", runtimeEnvironment),
];
let completed = false;
try {
  const apiBase = `http://127.0.0.1:${apiPort}`;
  await waitFor(`${apiBase}/health/ready`, async (response) => response.ok);
  const body = Buffer.from(
    JSON.stringify({
      eventType: "shipment.status_changed",
      occurredAt: new Date().toISOString(),
      subject: { type: "shipment", id: `hybrid-smoke-${randomUUID()}` },
      data: { trackingNumber: "PIRH-HYBRID-SMOKE", status: "in_transit" },
    }),
  );
  const accepted = await fetch(`${apiBase}/api/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `hybrid-smoke-${randomUUID()}`,
      ...signedHeaders("POST", "/api/v1/events", body),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (accepted.status !== 202)
    throw new Error("Hybrid event submission failed.");
  const acceptance = await accepted.json();
  if (typeof acceptance.eventId !== "string")
    throw new Error("Hybrid event acceptance is invalid.");
  const detailPath = `/api/v1/events/${acceptance.eventId}`;
  await waitFor(
    `${apiBase}${detailPath}`,
    async (response) => response.ok,
    () => signedHeaders("GET", detailPath),
  );
  const region = environment.AWS_REGION;
  const credentials = {
    accessKeyId: environment.AWS_ACCESS_KEY_ID,
    secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    sessionToken: environment.AWS_SESSION_TOKEN,
  };
  const ddb = new DynamoDBClient({ region, credentials });
  const sqs = new SQSClient({ region, credentials });
  const ssm = new SSMClient({ region, credentials });
  await waitForValue(async () => {
    const delivery = await ddb.send(
      new QueryCommand({
        TableName: environment.CORE_TABLE_NAME,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: `TENANT#${seed.tenantId}#EVENT#${acceptance.eventId}` },
        },
      }),
    );
    const states = (delivery.Items ?? [])
      .filter((item) => item.entityType?.S === "DELIVERY")
      .map(
        (item) =>
          `${item.state?.S ?? "missing"}:${item.blockedReason?.S ?? "none"}`,
      );
    return states.some((state) => state.startsWith("succeeded:"))
      ? true
      : `delivery-states:${states.join(",") || "none"}`;
  }, "development-table delivery evidence");
  await denied(
    async () =>
      await ddb.send(new DescribeTableCommand({ TableName: "pirh-demo-core" })),
  );
  await denied(
    async () =>
      await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: `https://sqs.${region}.amazonaws.com/204284492447/pirh-demo-delivery`,
        }),
      ),
  );
  await denied(
    async () =>
      await ssm.send(
        new GetParameterCommand({
          Name: "/pirh/demo/system/cursor-secret",
          WithDecryption: false,
        }),
      ),
  );
  const misconfigured = await runCaptured(
    "apps/delivery-worker/dist/index.js",
    {
      ...environment,
      DELIVERY_QUEUE_NAME: "pirh-demo-delivery",
    },
  ).then(
    () => false,
    () => true,
  );
  if (!misconfigured)
    throw new Error("Misconfigured local worker unexpectedly started.");
  console.log(
    JSON.stringify({
      delivery: "succeeded",
      isolatedQueue: "denied",
      isolatedTable: "denied",
      isolatedParameters: "denied",
      misconfiguredWorker: "rejected-before-polling",
    }),
  );
  completed = true;
} finally {
  await Promise.all(processes.map(stop));
}
if (completed) process.exit(0);
