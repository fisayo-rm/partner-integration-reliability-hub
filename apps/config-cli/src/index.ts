import { readFile, writeFile } from "node:fs/promises";
import { parseConfigurationBundle } from "@pirh/config-portability";

const [command, ...args] = process.argv.slice(2);
const baseUrl = process.env.PIRH_API_BASE_URL ?? "http://localhost:3000";
const accessToken = process.env.PIRH_ACCESS_TOKEN;

function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}
async function request(path: string, body: unknown) {
  if (accessToken === undefined || accessToken.length === 0)
    fail("PIRH_ACCESS_TOKEN is required.");
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => ({}));
  const errorCode =
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    (value as { readonly error?: { readonly code?: unknown } }).error !==
      undefined
      ? (value as { readonly error: { readonly code?: unknown } }).error.code
      : undefined;
  if (!response.ok)
    fail(
      typeof errorCode === "string"
        ? `Configuration command failed: ${errorCode}`
        : `Configuration command failed with HTTP ${response.status}.`,
    );
  return value as Record<string, unknown>;
}

if (command === "export") {
  const tenant = argument("--tenant");
  const output = argument("--output");
  if (tenant === undefined || output === undefined)
    fail("Usage: pnpm config export --tenant <external-key> --output <file>");
  const value = await request("/api/v1/configuration/exports", { tenant });
  if (typeof value.yaml !== "string")
    fail("Export response did not contain YAML.");
  await writeFile(output, value.yaml, "utf8");
  process.stdout.write(
    `${JSON.stringify({ output, digest: value.digest }, null, 2)}\n`,
  );
} else if (command === "import") {
  const file = args.find((value) => !value.startsWith("--"));
  const mode = ["--validate", "--plan", "--apply"].find((value) =>
    args.includes(value),
  );
  if (file === undefined || mode === undefined)
    fail("Usage: pnpm config import <file> --validate|--plan|--apply");
  const raw = await readFile(file, "utf8");
  const bundle = parseConfigurationBundle(raw);
  if (mode === "--validate") {
    const result = await request("/api/v1/configuration/imports/validate", {
      bundle,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (mode === "--plan") {
    const result = await request("/api/v1/configuration/imports/plan", {
      bundle,
    });
    await writeFile(
      `${file}.pirh-plan.json`,
      JSON.stringify(result, null, 2),
      "utf8",
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const planFile = `${file}.pirh-plan.json`;
    let receipt: unknown;
    try {
      receipt = JSON.parse(await readFile(planFile, "utf8")).receipt;
    } catch {
      fail(`Plan receipt missing. Run: pnpm config import ${file} --plan`);
    }
    if (typeof receipt !== "string") fail("Plan receipt is invalid.");
    const result = await request("/api/v1/configuration/imports/apply", {
      bundle,
      receipt,
    });
    const refreshed = await request("/api/v1/configuration/imports/plan", {
      bundle,
    });
    await writeFile(planFile, JSON.stringify(refreshed, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} else {
  fail("Usage: pnpm config export|import ...");
}
