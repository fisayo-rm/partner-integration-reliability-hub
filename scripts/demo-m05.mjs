import { spawn } from "node:child_process";

const controlToken = process.env.MOCK_CONTROL_TOKEN;
if (controlToken === undefined)
  throw new Error("MOCK_CONTROL_TOKEN is required for the M05 demo.");

const response = await fetch("http://localhost:4012/__control/mode", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mock-control-token": controlToken,
  },
  body: JSON.stringify({ mode: "503", failFirst: 1 }),
});
if (!response.ok)
  throw new Error("Could not configure transient Beta failure.");

const startedAt = Date.now();
await new Promise((resolve, reject) => {
  const child = spawn("node", ["scripts/demo-m04.mjs"], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`M05 retry demo exited ${code}`)),
  );
});

await fetch("http://localhost:4012/__control/mode", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mock-control-token": controlToken,
  },
  body: JSON.stringify({ mode: "success" }),
});
const elapsedMs = Date.now() - startedAt;
if (elapsedMs > 60_000)
  throw new Error(`M05 retry policy deadline exceeded after ${elapsedMs}ms.`);
console.log(
  JSON.stringify({
    demonstration:
      "Beta 503 produced a retry-scheduled delivery and attempt-two success",
    elapsedMs,
    deadlineMs: 60_000,
  }),
);
