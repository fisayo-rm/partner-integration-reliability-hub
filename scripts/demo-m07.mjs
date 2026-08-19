import { spawn } from "node:child_process";

const protectedValues = [
  process.env.LOCAL_SEED_PRODUCER_SECRET,
  process.env.LOCAL_SEED_ALPHA_API_KEY,
  process.env.LOCAL_SEED_BETA_CLIENT_SECRET,
  process.env.MOCK_CONTROL_TOKEN,
  process.env.LOCAL_CURSOR_SECRET,
].filter((value) => typeof value === "string" && value.length > 0);

function runDemo() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/demo-m06.mjs"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.pipe(process.stderr);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(JSON.parse(output.slice(output.indexOf("{")).trim()))
        : reject(new Error(`M06 foundation demo exited ${code}`)),
    );
  });
}
async function eventually(work, label, attempts = 30) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    last = await work();
    if (last) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} was not observed`);
}

const m06 = await runDemo();
const correlationId = m06.accepted?.correlationId;
if (typeof correlationId !== "string")
  throw new Error("M06 demo did not return a correlation ID.");

await eventually(async () => {
  const response = await fetch(
    "http://localhost:16686/api/traces?service=api&limit=20",
  );
  const body = await response.json();
  return response.ok && JSON.stringify(body).includes(correlationId);
}, "Jaeger correlation trace");
await eventually(async () => {
  const response = await fetch(
    "http://localhost:9090/api/v1/query?query=delivery_attempts_total",
  );
  const body = await response.json();
  return response.ok && body.data?.result?.length > 0;
}, "Prometheus delivery metric");
await eventually(async () => {
  const response = await fetch(
    `http://localhost:3100/loki/api/v1/query_range?query=${encodeURIComponent('{service_name=~".+"}')}`,
  );
  const body = await response.json();
  return response.ok && JSON.stringify(body).includes(correlationId);
}, "Loki correlated logs");
const dashboard = await fetch(
  "http://localhost:3001/api/dashboards/uid/pirh-m07-overview",
);
if (!dashboard.ok) throw new Error("Grafana M07 dashboard did not load.");
const observabilityText = await Promise.all([
  fetch("http://localhost:16686/api/traces?service=api&limit=20").then((r) =>
    r.text(),
  ),
  fetch(
    `http://localhost:3100/loki/api/v1/query_range?query=${encodeURIComponent('{service_name=~".+"}')}`,
  ).then((r) => r.text()),
]).then((parts) => parts.join("\n"));
for (const value of protectedValues)
  if (observabilityText.includes(value))
    throw new Error("A generated secret was found in observability output.");
console.log(`M07 observability demonstration passed for ${correlationId}.`);
