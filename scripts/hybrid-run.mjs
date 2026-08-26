import { spawn } from "node:child_process";
import { loadHybridRuntimeEnvironment } from "./hybrid-environment.mjs";

const service = process.argv.slice(2).find((value) => value !== "--");
const entries = {
  api: "apps/api/dist/server.js",
  "outbox-worker": "apps/outbox-worker/dist/index.js",
  "router-worker": "apps/router-worker/dist/index.js",
  "delivery-worker": "apps/delivery-worker/dist/index.js",
  "outbox-reconciler": "apps/outbox-reconciler/dist/index.js",
};
if (!(service in entries))
  throw new Error(
    `Select one local hybrid service: ${Object.keys(entries).join(", ")}.`,
  );

const { environment } = await loadHybridRuntimeEnvironment();
const child = spawn(process.execPath, [entries[service]], {
  env: environment,
  stdio: "inherit",
});
const signal = (name) => process.on(name, () => child.kill(name));
signal("SIGINT");
signal("SIGTERM");
child.on("exit", (code, terminationSignal) => {
  if (terminationSignal !== null) process.kill(process.pid, terminationSignal);
  process.exitCode = code ?? 1;
});
