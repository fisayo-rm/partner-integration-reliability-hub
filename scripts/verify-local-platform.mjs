import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { URLSearchParams } from "node:url";

const project = `pirh-m02-${Date.now()}`;
const requestedProfile = process.argv[2];
if (
  requestedProfile !== undefined &&
  requestedProfile !== "default" &&
  requestedProfile !== "observability"
)
  throw new Error(
    "Expected no profile, default, or observability for local platform verification.",
  );
const skipComposeBuild = process.env.PIRH_COMPOSE_SKIP_BUILD === "1";
const runM12Load = process.env.PIRH_RUN_M12_LOAD === "1";
const loadScenarios = (
  process.env.PIRH_LOAD_SCENARIOS ??
  "ingestion-only,one-destination,two-destinations,slow-beta,high-retry,rate-limited-hot,concurrent-search"
)
  .split(",")
  .filter((scenario) => scenario.length > 0);
const loadRates = {
  "ingestion-only": 100,
  "one-destination": 20,
  "two-destinations": 20,
  "slow-beta": 10,
  "high-retry": 10,
  "rate-limited-hot": 10,
  "concurrent-search": 20,
};
const diagnosticPath = process.env.PIRH_VERIFICATION_DIAGNOSTIC_PATH;
const composeEnvironment = {
  ...process.env,
  LOCAL_SECRET_MASTER_KEY_B64: randomBytes(32).toString("base64"),
  LOCAL_SEED_PRODUCER_SECRET: randomBytes(32).toString("base64url"),
  LOCAL_SEED_ALPHA_API_KEY: randomBytes(24).toString("base64url"),
  LOCAL_SEED_BETA_CLIENT_SECRET: randomBytes(24).toString("base64url"),
  LOCAL_SEED_TARGET_ALPHA_API_KEY: randomBytes(24).toString("base64url"),
  LOCAL_SEED_TARGET_BETA_CLIENT_SECRET: randomBytes(24).toString("base64url"),
  LOCAL_CURSOR_SECRET: randomBytes(32).toString("base64url"),
  PORTABILITY_PLAN_SIGNING_KEY_B64: randomBytes(32).toString("base64"),
  MOCK_CONTROL_TOKEN: randomBytes(24).toString("base64url"),
};
const base = [
  "compose",
  "--ansi",
  "never",
  "--progress",
  "quiet",
  "--project-name",
  project,
  "--project-directory",
  process.cwd(),
];
function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...base, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: composeEnvironment,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `docker compose ${args.join(" ")} exited ${code}: ${output.slice(-8_000)}`,
            ),
          ),
    );
  });
}
function dockerStats(containerIds) {
  return new Promise((resolve, reject) => {
    if (containerIds.length === 0) return resolve([]);
    const child = spawn(
      "docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
        ...containerIds,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: composeEnvironment },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0)
        return reject(new Error(`docker stats exited ${code}: ${output}`));
      return resolve(
        output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [name, cpu, memory] = line.split("\t");
            return { name, cpu, memory };
          }),
      );
    });
  });
}
function pnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...composeEnvironment,
        DYNAMODB_ENDPOINT: "http://localhost:8000",
        M02_TEST_MASTER_KEY_B64: composeEnvironment.LOCAL_SECRET_MASTER_KEY_B64,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `pnpm ${args.join(" ")} exited ${code}: ${output.slice(-8_000)}`,
            ),
          ),
    );
  });
}
async function eventually(url, label, maxAttempts = 40) {
  let lastError = "not attempted";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} did not become reachable: ${lastError}`);
}
async function verifyAcceptancePrecedesPartnerCall() {
  const captures = async () => {
    const response = await fetch("http://localhost:4011/__control/captures", {
      headers: {
        "x-mock-control-token": composeEnvironment.MOCK_CONTROL_TOKEN,
      },
    });
    if (!response.ok) throw new Error("Could not inspect Alpha captures.");
    const value = await response.json();
    return Array.isArray(value.items) ? value.items.length : 0;
  };
  await docker(["stop", "outbox-worker"]);
  const before = await captures();
  const body = JSON.stringify({
    eventType: "shipment.status_changed",
    occurredAt: new Date().toISOString(),
    subject: { type: "shipment", id: `m12-acceptance-${Date.now()}` },
    data: { status: "in_transit", source: "m12-acceptance-proof" },
    metadata: { source: "m12" },
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const signature = createHmac(
    "sha256",
    composeEnvironment.LOCAL_SEED_PRODUCER_SECRET,
  )
    .update(
      [
        "POST",
        "/api/v1/events",
        timestamp,
        nonce,
        createHash("sha256").update(body).digest("hex"),
      ].join("\n"),
    )
    .digest("base64url");
  const accepted = await fetch("http://localhost:3000/api/v1/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `m12-acceptance-${nonce}`,
      "x-client-id": "cli_01J0A1B2C3D4E5F6G7H8J9K0MN",
      "x-timestamp": timestamp,
      "x-nonce": nonce,
      "x-signature": signature,
    },
    body,
  });
  if (accepted.status !== 202)
    throw new Error(
      `Acceptance-before-delivery expected 202, got ${accepted.status}.`,
    );
  if ((await captures()) !== before)
    throw new Error("Partner was called while outbox publication was paused.");
  await docker(["start", "outbox-worker"]);
}
async function withPausedWorkers(work) {
  // The ingestion-only benchmark has already completed its authenticated
  // setup. Stop every non-ingestion process so a constrained local Docker VM
  // measures API/DynamoDB acceptance rather than idle UI/identity mocks.
  const services = [
    "outbox-worker",
    "outbox-reconciler",
    "router-worker",
    "delivery-worker",
    "console",
    "keycloak",
    "mock-partner-alpha",
    "mock-partner-beta",
  ];
  await docker(["stop", ...services]);
  try {
    return await work();
  } finally {
    await docker(["start", ...services]);
  }
}
async function adminToken() {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "pirh-console",
    username: "admin@example.test",
    password: "admin-demo-only",
  });
  const response = await fetch(
    "http://localhost:8080/realms/pirh-local/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  const value = await response.json();
  if (!response.ok || typeof value.access_token !== "string")
    throw new Error("Could not obtain local administrator access token.");
  return value.access_token;
}
async function setDestinationEnabled(token, externalKey, enabled) {
  const listed = await fetch(
    "http://localhost:3000/api/v1/destinations?limit=100",
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  const value = await listed.json();
  const destination = Array.isArray(value.items)
    ? value.items.find((item) => item?.externalKey === externalKey)
    : undefined;
  if (!listed.ok || destination === undefined)
    throw new Error(`Could not find local destination ${externalKey}.`);
  if (destination.enabled === enabled) return;
  const updated = await fetch(
    `http://localhost:3000/api/v1/destinations/${destination.destinationId}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "if-match": `"${destination.version}"`,
      },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!updated.ok)
    throw new Error(
      `Could not set ${externalKey} enabled=${enabled}: HTTP ${updated.status}.`,
    );
}
async function setMockMode(name, input) {
  const port = name === "alpha" ? 4011 : 4012;
  const response = await fetch(`http://localhost:${port}/__control/mode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mock-control-token": composeEnvironment.MOCK_CONTROL_TOKEN,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Could not configure ${name} mock mode.`);
}
async function configureLoadScenario(scenario) {
  const token = await adminToken();
  await Promise.all([
    setDestinationEnabled(token, "alpha-shipments", true),
    setDestinationEnabled(token, "beta-shipments", true),
    setMockMode("alpha", { mode: "success" }),
    setMockMode("beta", { mode: "success" }),
  ]);
  if (scenario === "one-destination")
    await setDestinationEnabled(token, "beta-shipments", false);
  if (scenario === "slow-beta") await setMockMode("beta", { mode: "timeout" });
  if (scenario === "high-retry")
    await setMockMode("beta", { mode: "503", failFirst: 100_000 });
  if (scenario === "rate-limited-hot")
    await setMockMode("alpha", { mode: "429", retryAfterSeconds: 1 });
  return async () => {
    await Promise.all([
      setDestinationEnabled(token, "alpha-shipments", true),
      setDestinationEnabled(token, "beta-shipments", true),
      setMockMode("alpha", { mode: "success" }),
      setMockMode("beta", { mode: "success" }),
    ]);
  };
}
async function startSearchProbe() {
  const token = await adminToken();
  const durations = [];
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const started = performance.now();
      const response = await fetch(
        "http://localhost:3000/api/v1/events?limit=20",
        {
          headers: { authorization: `Bearer ${token}` },
        },
      );
      durations.push(performance.now() - started);
      if (!response.ok)
        throw new Error(`Concurrent event search failed: ${response.status}.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return async () => {
    stopped = true;
    await done;
    if (durations.length === 0)
      throw new Error("Concurrent search had no samples.");
    const sorted = [...durations].sort((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    if (p95 >= 500)
      throw new Error(
        `Concurrent event-search p95 ${p95.toFixed(1)}ms exceeds 500ms.`,
      );
    return { samples: durations.length, p95Ms: p95 };
  };
}
async function runtimeSnapshot() {
  const queueOutput = await docker([
    "run",
    "--rm",
    "--entrypoint",
    "/bin/sh",
    "bootstrap",
    "-c",
    "aws sqs get-queue-attributes --endpoint-url http://elasticmq:9324 --queue-url http://elasticmq:9324/000000000000/pirh-routing-local --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --query Attributes --output json && aws sqs get-queue-attributes --endpoint-url http://elasticmq:9324 --queue-url http://elasticmq:9324/000000000000/pirh-delivery-local --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --query Attributes --output json",
  ]);
  const queues = [...queueOutput.matchAll(/\{[\s\S]*?\}/g)].map((match) =>
    JSON.parse(match[0]),
  );
  if (queues.length !== 2)
    throw new Error("Could not read local queue depths.");
  const containerIds = (await docker(["ps", "-q"]))
    .trim()
    .split("\n")
    .filter(Boolean);
  return {
    queueDepth: {
      routing: queues[0],
      delivery: queues[1],
    },
    containerStats: await dockerStats(containerIds),
  };
}
async function runLoadScenario(scenario) {
  const rate = loadRates[scenario];
  if (rate === undefined)
    throw new Error(`Unknown M12 load scenario ${scenario}.`);
  const cleanup = await configureLoadScenario(scenario);
  const stopSearch =
    scenario === "concurrent-search" ? await startSearchProbe() : undefined;
  const before = await runtimeSnapshot();
  let summary;
  const work = async () => {
    const output = await docker([
      "--profile",
      "load",
      "run",
      "--rm",
      "-e",
      `PIRH_LOAD_SCENARIO=${scenario}`,
      "-e",
      `PIRH_K6_RATE=${rate}`,
      "-e",
      "PIRH_K6_DURATION=60s",
      "k6",
    ]);
    summary = output
      .split("\n")
      .find((line) => line.startsWith("PIRH_K6_SUMMARY="));
    if (summary === undefined)
      throw new Error(
        `k6 ${scenario} did not emit a machine-readable summary.`,
      );
  };
  try {
    if (scenario === "ingestion-only") await withPausedWorkers(work);
    else await work();
  } finally {
    try {
      if (stopSearch !== undefined) {
        const search = await stopSearch();
        await writeFile(
          `load-artifacts/${scenario}-search.json`,
          `${JSON.stringify(search, null, 2)}\n`,
        );
      }
    } finally {
      await cleanup();
    }
  }
  if (summary === undefined)
    throw new Error(`k6 ${scenario} completed without a summary.`);
  await writeFile(
    `load-artifacts/${scenario}.json`,
    `${JSON.stringify(
      {
        ...JSON.parse(summary.slice("PIRH_K6_SUMMARY=".length)),
        runtime: { before, after: await runtimeSnapshot() },
      },
      null,
      2,
    )}\n`,
  );
}
async function startLocalPlatform(profile, includeBuild) {
  if (profile === "observability")
    composeEnvironment.PIRH_OTLP_ENDPOINT = "http://otel-collector:4318";
  else delete composeEnvironment.PIRH_OTLP_ENDPOINT;
  if (runM12Load) composeEnvironment.LOG_LEVEL = "warn";
  const build = includeBuild && !skipComposeBuild ? ["--build"] : [];
  const args = profile
    ? ["--profile", profile, "up", ...build, "--detach", "--wait"]
    : ["up", ...build, "--detach", "--wait"];
  await docker(args);
  for (const [url, label] of [
    ["http://localhost:3000/health/ready", "API readiness"],
    ["http://localhost:5173/", "console"],
    ["http://localhost:4011/health/ready", "mock partner alpha"],
    ["http://localhost:4012/health/ready", "mock partner beta"],
    [
      "http://localhost:8080/realms/pirh-local/.well-known/openid-configuration",
      "Keycloak realm",
    ],
  ])
    await eventually(url, label);
  await docker([
    "run",
    "--rm",
    "--entrypoint",
    "/bin/sh",
    "bootstrap",
    "-c",
    "/bin/sh /bootstrap/bootstrap.sh && /bin/sh /bootstrap/assert.sh",
  ]);
}
async function verify(profile) {
  await startLocalPlatform(profile, true);
  await pnpm(["test:integration"]);
  await verifyAcceptancePrecedesPartnerCall();
  await pnpm(["demo:m04"]);
  await pnpm(["demo:m05"]);
  await pnpm(["demo:m06"]);
  await pnpm(["demo:m09"]);
  if (profile === undefined) await pnpm(["test:e2e"]);
  if (runM12Load) {
    await mkdir("load-artifacts", { recursive: true });
    for (const scenario of loadScenarios) {
      // Every scenario starts with a distinct, automatically seeded platform.
      // That keeps queued work, rate permits, and circuit state isolated.
      await docker([
        "down",
        "--timeout",
        "15",
        "--volumes",
        "--remove-orphans",
      ]);
      await startLocalPlatform(profile, false);
      await runLoadScenario(scenario);
    }
  }
  if (profile === "observability") {
    for (const [url, label, maxAttempts] of [
      ["http://localhost:13133/", "OpenTelemetry collector"],
      ["http://localhost:9090/-/ready", "Prometheus"],
      ["http://localhost:3100/ready", "Loki", 90],
      ["http://localhost:16686/", "Jaeger"],
      ["http://localhost:3001/api/health", "Grafana"],
    ])
      await eventually(url, label, maxAttempts);
    await pnpm(["demo:m07"]);
  }
}
try {
  await pnpm(["build"]);
  await docker(["config", "--quiet"]);
  if (requestedProfile === "default") {
    await verify();
    console.log("Local platform verification passed for the default profile.");
  } else if (requestedProfile === "observability") {
    await verify("observability");
    console.log(
      "Local platform verification passed for the observability profile.",
    );
  } else {
    await verify();
    await docker(["down", "--timeout", "15", "--volumes", "--remove-orphans"]);
    await verify("observability");
    console.log(
      "Local platform verification passed for default and observability profiles.",
    );
  }
} catch (error) {
  if (diagnosticPath !== undefined)
    await writeFile(
      diagnosticPath,
      `${error instanceof Error ? error.stack : String(error)}\n`,
    ).catch(() => undefined);
  throw error;
} finally {
  await docker([
    "down",
    "--timeout",
    "15",
    "--volumes",
    "--remove-orphans",
  ]).catch(() => undefined);
}
