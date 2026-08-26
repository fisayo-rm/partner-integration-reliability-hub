import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createBackup, restoreBackup } from "@pirh/recovery";

const [command, ...args] = process.argv.slice(2);
function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}
const environment = argument("--environment");
const targetEnvironment = argument("--target-environment");
const local = environment === "local" || targetEnvironment === "restore-test";
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(local
      ? {
          endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  }),
);

if (command === "backup") {
  if (environment !== "local" && environment !== "demo")
    fail("Backup environment must be local or demo.");
  const tenantId = argument("--tenant");
  const outputDirectory = argument("--output");
  if (tenantId === undefined || outputDirectory === undefined)
    fail(
      "Usage: pnpm ops:backup --environment <local|demo> --tenant <id> --output <dir>",
    );
  const result = await createBackup({
    client,
    environment,
    tenantId,
    outputDirectory,
    coreTableName:
      argument("--core-table") ??
      (environment === "local" ? "pirh-core-local" : "pirh-demo-core"),
    auditTableName:
      argument("--audit-table") ??
      (environment === "local" ? "pirh-audit-local" : "pirh-demo-audit"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === "restore") {
  const source = argument("--source");
  const coreTableName = argument("--core-table");
  const auditTableName = argument("--audit-table");
  if (
    source === undefined ||
    targetEnvironment === undefined ||
    coreTableName === undefined ||
    auditTableName === undefined
  )
    fail(
      "Usage: pnpm ops:restore --source <manifest> --target-environment restore-test --core-table <name> --audit-table <name> --allow-restore",
    );
  const manifest = await restoreBackup({
    client,
    manifestPath: source,
    targetEnvironment,
    coreTableName,
    auditTableName,
    allowRestore: args.includes("--allow-restore"),
  });
  process.stdout.write(`${JSON.stringify({ restored: manifest }, null, 2)}\n`);
} else {
  fail("Usage: pnpm ops:backup|ops:restore ...");
}
