import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN";
const project = `pirh-m12-restore-${Date.now()}`;
const restoreCore = "pirh-restore-core";
const restoreAudit = "pirh-restore-audit";
const sourceSecrets = {
  LOCAL_SECRET_MASTER_KEY_B64: randomBytes(32).toString("base64"),
  LOCAL_SEED_PRODUCER_SECRET: randomBytes(32).toString("base64url"),
  LOCAL_SEED_ALPHA_API_KEY: randomBytes(24).toString("base64url"),
  LOCAL_SEED_BETA_CLIENT_SECRET: randomBytes(24).toString("base64url"),
  LOCAL_SEED_TARGET_ALPHA_API_KEY: randomBytes(24).toString("base64url"),
  LOCAL_SEED_TARGET_BETA_CLIENT_SECRET: randomBytes(24).toString("base64url"),
  LOCAL_CURSOR_SECRET: randomBytes(32).toString("base64url"),
  PORTABILITY_PLAN_SIGNING_KEY_B64: randomBytes(32).toString("base64"),
  MOCK_CONTROL_TOKEN: randomBytes(24).toString("base64url"),
};
const targetSecrets = {
  LOCAL_SECRET_MASTER_KEY_B64: randomBytes(32).toString("base64"),
  LOCAL_SEED_PRODUCER_SECRET: randomBytes(32).toString("base64url"),
  LOCAL_SEED_ALPHA_API_KEY: randomBytes(24).toString("base64url"),
  LOCAL_SEED_BETA_CLIENT_SECRET: randomBytes(24).toString("base64url"),
  LOCAL_SEED_TARGET_ALPHA_API_KEY: randomBytes(24).toString("base64url"),
  LOCAL_SEED_TARGET_BETA_CLIENT_SECRET: randomBytes(24).toString("base64url"),
  LOCAL_CURSOR_SECRET: randomBytes(32).toString("base64url"),
  PORTABILITY_PLAN_SIGNING_KEY_B64: randomBytes(32).toString("base64"),
  MOCK_CONTROL_TOKEN: randomBytes(24).toString("base64url"),
};
const composeEnvironment = { ...process.env, ...sourceSecrets };
const composeBase = [
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

function run(command, args, environment = composeEnvironment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
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
    child.on("exit", (code) => {
      if (code === 0) return resolve(output);
      return reject(
        new Error(
          `${command} ${args.join(" ")} exited ${code}: ${output.slice(-8_000)}`,
        ),
      );
    });
  });
}
function docker(args) {
  return run("docker", [...composeBase, ...args]);
}
function pnpm(args, environment) {
  return run("pnpm", args, environment);
}
function hmacHeaders(secret, body, idempotencyKey) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomBytes(18).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(
      [
        "POST",
        "/api/v1/events",
        timestamp,
        nonce,
        createHash("sha256").update(body).digest("hex"),
      ].join("\n"),
    )
    .digest("base64url");
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-client-id": "cli_01J0A1B2C3D4E5F6G7H8J9K0MN",
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": signature,
  };
}
async function acceptedEvent(secret, label) {
  const body = JSON.stringify({
    eventType: "shipment.status_changed",
    occurredAt: new Date().toISOString(),
    subject: { type: "shipment", id: `${label}-${Date.now()}` },
    data: {
      trackingNumber: `${label}-${randomBytes(5).toString("hex")}`,
      status: "in_transit",
      estimatedDelivery: "2026-09-01T00:00:00.000Z",
    },
    metadata: { source: "m12-recovery-drill" },
  });
  const response = await fetch("http://localhost:3000/api/v1/events", {
    method: "POST",
    headers: hmacHeaders(
      secret,
      body,
      `m12-${label}-${randomBytes(12).toString("base64url")}`,
    ),
    body,
  });
  if (response.status !== 202)
    throw new Error(
      `${label} acceptance expected HTTP 202, got ${response.status}.`,
    );
  return new Date();
}
async function eventually(url, label) {
  let last = "not attempted";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} did not become ready: ${last}`);
}
async function scanAll(client, tableName) {
  const items = [];
  let lastKey;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ...(lastKey === undefined ? {} : { ExclusiveStartKey: lastKey }),
      }),
    );
    items.push(...(page.Items ?? []));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey !== undefined);
  return items;
}
function snapshotItems(directory, file) {
  return readFile(join(directory, file)).then((compressed) => {
    const content = gunzipSync(compressed).toString("utf8").trim();
    return content === ""
      ? []
      : content.split("\n").map((line) => JSON.parse(line));
  });
}
function keyDigest(items) {
  return createHash("sha256")
    .update(
      [...items]
        .map((item) => `${item.PK}\u0000${item.SK}`)
        .sort()
        .join("\n"),
    )
    .digest("hex");
}
function logicalReferences(value, found = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => logicalReferences(entry, found));
    return found;
  }
  if (value === null || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === "secretReferences" || key === "secretVersions") &&
      Array.isArray(child)
    ) {
      for (const entry of child) {
        const reference = entry?.reference ?? entry;
        if (typeof reference?.name === "string") found.add(reference.name);
      }
    }
    logicalReferences(child, found);
  }
  return found;
}
async function createRestoreTables(client) {
  await client.send(
    new CreateTableCommand({
      TableName: restoreCore,
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
          ProvisionedThroughput: {
            ReadCapacityUnits: 1,
            WriteCapacityUnits: 1,
          },
        },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    }),
  );
  await client.send(
    new CreateTableCommand({
      TableName: restoreAudit,
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 },
    }),
  );
  for (const tableName of [restoreCore, restoreAudit]) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const table = await client.send(
        new DescribeTableCommand({ TableName: tableName }),
      );
      if (table.Table?.TableStatus === "ACTIVE") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

const backupDirectory = await mkdtemp(join(tmpdir(), "pirh-m12-restore-"));
const awsEnvironment = {
  ...process.env,
  DYNAMODB_ENDPOINT: "http://localhost:8000",
  AWS_REGION: "us-east-1",
};
const rawClient = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://localhost:8000",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const documentClient = DynamoDBDocumentClient.from(rawClient);
try {
  await docker(["up", "--build", "--detach", "--wait"]);
  await eventually("http://localhost:3000/health/ready", "source API");
  const lastProtectedAt = await acceptedEvent(
    sourceSecrets.LOCAL_SEED_PRODUCER_SECRET,
    "source",
  );
  const backupStartedAt = new Date();
  await pnpm(
    [
      "ops:backup",
      "--environment",
      "local",
      "--tenant",
      tenantId,
      "--output",
      backupDirectory,
    ],
    awsEnvironment,
  );
  const backupFinishedAt = new Date();
  const manifestPath = join(backupDirectory, "manifest.v1.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const [coreSnapshot, auditSnapshot] = await Promise.all([
    snapshotItems(backupDirectory, manifest.files.core.file),
    snapshotItems(backupDirectory, manifest.files.audit.file),
  ]);
  if (
    coreSnapshot.some((item) => item.entityType === "LOCAL_SECRET") ||
    auditSnapshot.some((item) => item.entityType === "LOCAL_SECRET")
  )
    throw new Error("Recovery snapshot included a local secret record.");
  await createRestoreTables(rawClient);
  const restoreStartedAt = new Date();
  await pnpm(
    [
      "ops:restore",
      "--source",
      manifestPath,
      "--target-environment",
      "restore-test",
      "--core-table",
      restoreCore,
      "--audit-table",
      restoreAudit,
      "--allow-restore",
    ],
    awsEnvironment,
  );
  const [restoredCore, restoredAudit] = await Promise.all([
    scanAll(documentClient, restoreCore),
    scanAll(documentClient, restoreAudit),
  ]);
  if (
    restoredCore.length !== coreSnapshot.length ||
    restoredAudit.length !== auditSnapshot.length ||
    keyDigest(restoredCore) !== keyDigest(coreSnapshot) ||
    keyDigest(restoredAudit) !== keyDigest(auditSnapshot)
  )
    throw new Error(
      "Restored record count or key digest differs from snapshot.",
    );
  const sourceReferences = [
    ...logicalReferences([...coreSnapshot, ...auditSnapshot]),
  ].sort();
  const restoredReferences = [
    ...logicalReferences([...restoredCore, ...restoredAudit]),
  ].sort();
  if (JSON.stringify(sourceReferences) !== JSON.stringify(restoredReferences))
    throw new Error("Restored logical secret references differ from snapshot.");

  Object.assign(composeEnvironment, targetSecrets, {
    CORE_TABLE_NAME: restoreCore,
    AUDIT_TABLE_NAME: restoreAudit,
    LOCAL_SEED_MODE: "rebind-only",
  });
  await docker([
    "rm",
    "--stop",
    "--force",
    "seed",
    "api",
    "outbox-worker",
    "outbox-reconciler",
    "router-worker",
    "delivery-worker",
    "mock-partner-alpha",
    "mock-partner-beta",
  ]);
  await docker(["up", "--no-deps", "--detach", "--wait", "seed"]);
  await docker([
    "up",
    "--no-deps",
    "--detach",
    "--wait",
    "api",
    "outbox-worker",
    "outbox-reconciler",
    "router-worker",
    "delivery-worker",
    "mock-partner-alpha",
    "mock-partner-beta",
  ]);
  await eventually("http://localhost:3000/health/ready", "restored API");
  const aliases = (await scanAll(documentClient, restoreCore)).filter(
    (item) =>
      item.entityType === "LOCAL_SECRET" ||
      item.entityType === "LOCAL_SECRET_HEAD",
  );
  if (aliases.length < 6)
    throw new Error(
      "Fresh local-only secret aliases were not rebound after restore.",
    );
  await acceptedEvent(targetSecrets.LOCAL_SEED_PRODUCER_SECRET, "restored");
  const recoveredAt = new Date();
  process.stdout.write(
    `${JSON.stringify(
      {
        version: 1,
        tenantId,
        source: {
          coreRecords: coreSnapshot.length,
          auditRecords: auditSnapshot.length,
          coreKeyDigest: keyDigest(coreSnapshot),
          auditKeyDigest: keyDigest(auditSnapshot),
          logicalReferences: sourceReferences,
        },
        restore: {
          coreRecords: restoredCore.length,
          auditRecords: restoredAudit.length,
          reboundLocalAliasRecords: aliases.length,
          rpoMs: backupFinishedAt.getTime() - lastProtectedAt.getTime(),
          rtoMs: recoveredAt.getTime() - restoreStartedAt.getTime(),
          backupDurationMs:
            backupFinishedAt.getTime() - backupStartedAt.getTime(),
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await docker([
    "down",
    "--timeout",
    "15",
    "--volumes",
    "--remove-orphans",
  ]).catch(() => undefined);
  await rm(backupDirectory, { recursive: true, force: true });
}
