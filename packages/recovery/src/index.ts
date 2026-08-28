import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

export interface BackupFileV1 {
  readonly file: string;
  readonly recordCount: number;
  readonly sha256: string;
}
/** Versioned, logical recovery-snapshot manifest. It is not a portability bundle. */
export interface BackupManifestV1 {
  readonly version: 1;
  readonly kind: "pirh-recovery-snapshot";
  readonly environment: "local" | "demo";
  readonly tenantId: string;
  readonly createdAt: string;
  readonly files: Readonly<{
    readonly core: BackupFileV1;
    readonly audit: BackupFileV1;
  }>;
}

type Item = Record<string, unknown>;
const localSecretTypes = new Set(["LOCAL_SECRET", "LOCAL_SECRET_HEAD"]);
const credentialKey =
  /(secret|password|access[_-]?token|refresh[_-]?token|private[_-]?key|api[_-]?key)/i;
const referenceKey =
  /(?:secretReference|secretReferenceNames|secretName|secretId|secretVersions?|parameterName)/i;

function hasOnlyRedactedSensitiveHeaders(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  return Object.entries(value as Item).every(
    ([name, headerValue]) =>
      typeof headerValue === "string" &&
      (!credentialKey.test(name) || headerValue === "[REDACTED]"),
  );
}

function hasOnlyLogicalSecretVersions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        return false;
      const record = entry as Item;
      const reference = record.reference;
      return (
        reference !== null &&
        typeof reference === "object" &&
        !Array.isArray(reference) &&
        Object.keys(record).every((key) =>
          ["reference", "state", "activatedAt", "graceExpiresAt"].includes(key),
        ) &&
        Object.keys(reference as Item).every((key) =>
          ["name", "version"].includes(key),
        ) &&
        typeof (reference as Item).name === "string" &&
        typeof (reference as Item).version === "string" &&
        (record.state === "active" || record.state === "grace") &&
        typeof record.activatedAt === "string" &&
        (record.graceExpiresAt === undefined ||
          typeof record.graceExpiresAt === "string")
      );
    })
  );
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}
function checksum(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function assertSnapshotSafe(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSnapshotSafe(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Item)) {
    if (
      /^requestHeadersRedacted$/i.test(key) &&
      hasOnlyRedactedSensitiveHeaders(child)
    )
      continue;
    if (/^secretVersions?$/i.test(key)) {
      if (!hasOnlyLogicalSecretVersions(child))
        throw new Error(
          `Recovery snapshot refused malformed logical secret versions at ${path}.${key}.`,
        );
      continue;
    }
    if (credentialKey.test(key) && !referenceKey.test(key))
      throw new Error(
        `Recovery snapshot refused credential-shaped field ${path}.${key}.`,
      );
    assertSnapshotSafe(child, `${path}.${key}`);
  }
}
function isLocalSecret(item: Item): boolean {
  return localSecretTypes.has(String(item.entityType));
}
function belongsToTenant(item: Item, tenantId: string): boolean {
  return (
    item.tenantId === tenantId ||
    String(item.PK ?? "").startsWith(`TENANT#${tenantId}#`)
  );
}
function deterministicLines(items: readonly Item[]): Buffer {
  const lines = [...items]
    .sort((left, right) =>
      `${left.PK ?? ""}\u0000${left.SK ?? ""}`.localeCompare(
        `${right.PK ?? ""}\u0000${right.SK ?? ""}`,
      ),
    )
    .map((item) => stable(item))
    .join("\n");
  return Buffer.from(lines.length === 0 ? "" : `${lines}\n`, "utf8");
}
async function scanTenant(
  client: DynamoDBDocumentClient,
  tableName: string,
  tenantId: string,
): Promise<Item[]> {
  const values: Item[] = [];
  let lastKey: Item | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: tableName,
        ...(lastKey === undefined ? {} : { ExclusiveStartKey: lastKey }),
      }),
    );
    for (const raw of result.Items ?? []) {
      const item = raw as Item;
      if (!belongsToTenant(item, tenantId)) continue;
      if (isLocalSecret(item)) continue;
      assertSnapshotSafe(item);
      values.push(item);
    }
    lastKey = result.LastEvaluatedKey as Item | undefined;
  } while (lastKey !== undefined);
  return values;
}
async function writeGzip(
  file: string,
  items: readonly Item[],
): Promise<BackupFileV1> {
  // gzipSync is deterministic for identical input on the supported Node runtime.
  const compressed = gzipSync(deterministicLines(items));
  await writeFile(file, compressed);
  return {
    file: file.split("/").at(-1) ?? file,
    recordCount: items.length,
    sha256: checksum(compressed),
  };
}
export async function createBackup(input: {
  readonly client: DynamoDBDocumentClient;
  readonly environment: "local" | "demo";
  readonly tenantId: string;
  readonly outputDirectory: string;
  readonly coreTableName: string;
  readonly auditTableName: string;
  readonly now?: Date;
}): Promise<{
  readonly manifestPath: string;
  readonly manifest: BackupManifestV1;
}> {
  await mkdir(input.outputDirectory, { recursive: true });
  const [core, audit] = await Promise.all([
    scanTenant(input.client, input.coreTableName, input.tenantId),
    scanTenant(input.client, input.auditTableName, input.tenantId),
  ]);
  const [coreFile, auditFile] = await Promise.all([
    writeGzip(join(input.outputDirectory, "core.ndjson.gz"), core),
    writeGzip(join(input.outputDirectory, "audit.ndjson.gz"), audit),
  ]);
  const manifest: BackupManifestV1 = {
    version: 1,
    kind: "pirh-recovery-snapshot",
    environment: input.environment,
    tenantId: input.tenantId,
    createdAt: (input.now ?? new Date()).toISOString(),
    files: { core: coreFile, audit: auditFile },
  };
  const manifestPath = join(input.outputDirectory, "manifest.v1.json");
  await writeFile(manifestPath, `${stable(manifest)}\n`, "utf8");
  return { manifestPath, manifest };
}
function parseManifest(value: unknown): BackupManifestV1 {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1 ||
    (value as { kind?: unknown }).kind !== "pirh-recovery-snapshot"
  )
    throw new Error("Recovery manifest is not BackupManifestV1.");
  const manifest = value as BackupManifestV1;
  if (!manifest.tenantId || !manifest.files?.core || !manifest.files?.audit)
    throw new Error("Recovery manifest is incomplete.");
  return manifest;
}
async function readSnapshotFile(
  path: string,
  expected: BackupFileV1,
): Promise<Item[]> {
  const compressed = await readFile(path);
  if (checksum(compressed) !== expected.sha256)
    throw new Error(`Checksum mismatch for ${expected.file}.`);
  const text = gunzipSync(compressed).toString("utf8");
  const lines = text.length === 0 ? [] : text.trimEnd().split("\n");
  if (lines.length !== expected.recordCount)
    throw new Error(`Record count mismatch for ${expected.file}.`);
  return lines.map((line) => {
    const item = JSON.parse(line) as Item;
    if (isLocalSecret(item))
      throw new Error("Recovery input contains a local secret record.");
    assertSnapshotSafe(item);
    return item;
  });
}
async function assertEmpty(
  client: DynamoDBDocumentClient,
  tableName: string,
): Promise<void> {
  const result = await client.send(
    new ScanCommand({ TableName: tableName, Limit: 1 }),
  );
  if ((result.Items?.length ?? 0) > 0)
    throw new Error(`Restore target ${tableName} is not empty.`);
}
async function batchWrite(
  client: DynamoDBDocumentClient,
  tableName: string,
  items: readonly Item[],
): Promise<void> {
  for (let index = 0; index < items.length; index += 25) {
    let pending = items
      .slice(index, index + 25)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length > 0 && attempt < 8; attempt += 1) {
      const result = await client.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      pending = (result.UnprocessedItems?.[tableName] ?? []) as typeof pending;
      if (pending.length > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1_000, 25 * 2 ** attempt)),
        );
    }
    if (pending.length > 0)
      throw new Error(`Restore left unprocessed records in ${tableName}.`);
  }
}
export async function restoreBackup(input: {
  readonly client: DynamoDBDocumentClient;
  readonly manifestPath: string;
  readonly targetEnvironment: string;
  readonly coreTableName: string;
  readonly auditTableName: string;
  readonly allowRestore: boolean;
}): Promise<BackupManifestV1> {
  if (!input.allowRestore) throw new Error("Restore requires --allow-restore.");
  if (input.targetEnvironment !== "restore-test")
    throw new Error("Restore target environment must be exactly restore-test.");
  for (const table of [input.coreTableName, input.auditTableName])
    if (!/^pirh-restore-/.test(table))
      throw new Error(
        `Restore target ${table} must use the pirh-restore- prefix.`,
      );
  const manifest = parseManifest(
    JSON.parse(await readFile(input.manifestPath, "utf8")),
  );
  if (input.coreTableName === input.auditTableName)
    throw new Error("Core and audit restore targets must be different tables.");
  const base = dirname(input.manifestPath);
  const [core, audit] = await Promise.all([
    readSnapshotFile(join(base, manifest.files.core.file), manifest.files.core),
    readSnapshotFile(
      join(base, manifest.files.audit.file),
      manifest.files.audit,
    ),
  ]);
  for (const item of [...core, ...audit])
    if (!belongsToTenant(item, manifest.tenantId))
      throw new Error("Recovery input contains a record for another tenant.");
  await Promise.all([
    assertEmpty(input.client, input.coreTableName),
    assertEmpty(input.client, input.auditTableName),
  ]);
  await batchWrite(input.client, input.coreTableName, core);
  await batchWrite(input.client, input.auditTableName, audit);
  return manifest;
}
