import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [metadataPath, consoleArtifact] = process.argv.slice(2);
const project = process.env.CLOUDFLARE_PAGES_PROJECT;
if (
  metadataPath === undefined ||
  consoleArtifact === undefined ||
  project === undefined
)
  throw new Error(
    "metadata path, console artifact, and CLOUDFLARE_PAGES_PROJECT are required.",
  );
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (
  metadata.schemaVersion !== 1 ||
  typeof metadata.sourceSha !== "string" ||
  !Array.isArray(metadata.lambdaAliases) ||
  metadata.lambdaAliases.length === 0
)
  throw new Error("Rollback metadata is invalid.");
await stat(consoleArtifact);
for (const value of metadata.lambdaAliases) {
  if (
    typeof value?.functionName !== "string" ||
    value.alias !== "live" ||
    typeof value.version !== "string"
  )
    throw new Error("Rollback metadata has an invalid Lambda alias entry.");
  await execute(
    "aws",
    [
      "lambda",
      "update-alias",
      "--function-name",
      value.functionName,
      "--name",
      value.alias,
      "--function-version",
      value.version,
    ],
    { encoding: "utf8" },
  );
}
await execute(
  "pnpm",
  [
    "wrangler",
    "pages",
    "deploy",
    consoleArtifact,
    "--project-name",
    project,
    "--branch",
    "main",
  ],
  { encoding: "utf8" },
);
console.log(
  JSON.stringify({
    rolledBack: true,
    sourceSha: metadata.sourceSha,
    lambdaAliases: metadata.lambdaAliases.length,
    dataHistory: "unchanged",
  }),
);
