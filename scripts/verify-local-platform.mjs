import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const project = `pirh-m02-${Date.now()}`;
const composeEnvironment = {
  ...process.env,
  LOCAL_SECRET_MASTER_KEY_B64: randomBytes(32).toString("base64"),
  LOCAL_SEED_PRODUCER_SECRET: randomBytes(32).toString("base64url"),
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
        ? resolve()
        : reject(
            new Error(
              `docker compose ${args.join(" ")} exited ${code}: ${output.slice(-8_000)}`,
            ),
          ),
    );
  });
}
function pnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      stdio: "inherit",
      env: {
        ...composeEnvironment,
        DYNAMODB_ENDPOINT: "http://localhost:8000",
        M02_TEST_MASTER_KEY_B64: composeEnvironment.LOCAL_SECRET_MASTER_KEY_B64,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pnpm ${args.join(" ")} exited ${code}`)),
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
async function verify(profile) {
  const args = profile
    ? ["--profile", profile, "up", "--build", "--detach", "--wait"]
    : ["up", "--build", "--detach", "--wait"];
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
  await pnpm(["test:integration"]);
  if (profile === "observability") {
    for (const [url, label, maxAttempts] of [
      ["http://localhost:13133/", "OpenTelemetry collector"],
      ["http://localhost:9090/-/ready", "Prometheus"],
      ["http://localhost:3100/ready", "Loki", 90],
      ["http://localhost:16686/", "Jaeger"],
      ["http://localhost:3001/api/health", "Grafana"],
    ])
      await eventually(url, label, maxAttempts);
  }
}
try {
  await docker(["config", "--quiet"]);
  await verify();
  await docker(["down", "--volumes", "--remove-orphans"]);
  await verify("observability");
  console.log(
    "Local platform verification passed for default and observability profiles.",
  );
} finally {
  await docker(["down", "--volumes", "--remove-orphans"]).catch(
    () => undefined,
  );
}
