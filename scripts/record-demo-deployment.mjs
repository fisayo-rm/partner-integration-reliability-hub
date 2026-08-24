import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const outputPath = process.env.DEPLOYMENT_METADATA_FILE;
const sourceSha = process.env.GITHUB_SHA;
const consoleOrigin = process.env.HOSTED_CONSOLE_ORIGIN;
if (
  outputPath === undefined ||
  sourceSha === undefined ||
  consoleOrigin === undefined
)
  throw new Error(
    "DEPLOYMENT_METADATA_FILE, GITHUB_SHA, and HOSTED_CONSOLE_ORIGIN are required.",
  );
const stacks = ["PirhDemoApi", "PirhDemoWorkers", "PirhDemoMockPartners"];
async function aws(...command) {
  const { stdout } = await execute("aws", command, { encoding: "utf8" });
  return stdout;
}
const functionNames = new Set();
for (const stack of stacks) {
  const raw = await aws(
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    stack,
    "--query",
    "StackResourceSummaries[?ResourceType==`AWS::Lambda::Function`].PhysicalResourceId",
    "--output",
    "json",
  );
  for (const name of JSON.parse(raw)) functionNames.add(name);
}
const aliases = [];
for (const functionName of [...functionNames].sort()) {
  const raw = await aws(
    "lambda",
    "list-aliases",
    "--function-name",
    functionName,
    "--query",
    "Aliases[?Name==`live`].{name:Name,version:FunctionVersion}",
    "--output",
    "json",
  );
  for (const alias of JSON.parse(raw))
    aliases.push({ functionName, alias: alias.name, version: alias.version });
}
if (aliases.length === 0) throw new Error("No live Lambda aliases were found.");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceSha,
      consoleOrigin,
      lambdaAliases: aliases,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(
  JSON.stringify({
    recorded: true,
    sourceSha,
    consoleOrigin,
    lambdaAliases: aliases.length,
  }),
);
