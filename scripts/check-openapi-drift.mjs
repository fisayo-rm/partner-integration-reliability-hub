import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";

const build = spawnSync("pnpm", ["--filter", "@pirh/api", "build"], {
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);
const { buildApi } = await import("../apps/api/dist/app.js");
const app = await buildApi({
  requiredConfiguration: async () => ({ name: "configuration", ok: true }),
  dynamoDb: async () => ({ name: "dynamodb", ok: true }),
  elasticMq: async () => ({ name: "queues", ok: true }),
});
try {
  const response = await app.inject("/openapi.json");
  const expected = await readFile(
    new URL("../openapi.json", import.meta.url),
    "utf8",
  );
  if (
    JSON.stringify(JSON.parse(response.body)) !==
    JSON.stringify(JSON.parse(expected))
  )
    throw new Error(
      "openapi.json differs from the deterministic runtime document.",
    );
} finally {
  await app.close();
}
console.log("OpenAPI artifact matches runtime generation.");
