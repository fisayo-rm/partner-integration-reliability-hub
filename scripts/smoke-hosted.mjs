const apiBase = process.env.HOSTED_API_URL;
const consoleOrigin = process.env.HOSTED_CONSOLE_ORIGIN;
if (apiBase === undefined || consoleOrigin === undefined)
  throw new Error(
    "HOSTED_API_URL and HOSTED_CONSOLE_ORIGIN must be supplied by deployment outputs.",
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
console.log(JSON.stringify({ api: "ready", console: "reachable" }));
