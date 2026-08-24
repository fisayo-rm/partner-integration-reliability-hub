import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  GetParameterCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import type { SecretReference, TenantContext } from "@pirh/domain";
import type { SecretStore } from "@pirh/application";

interface SecretItem {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly version: string;
}
export interface LocalSecretStoreConfig {
  readonly coreTableName: string;
  readonly masterKeyBase64: string;
}
function secretKey(context: TenantContext, name: string, version: string) {
  return {
    PK: `TENANT#${context.tenantId}#SECRET`,
    SK: `SECRET#${name}#VERSION#${version}`,
  };
}
function secretHeadKey(context: TenantContext, name: string) {
  return {
    PK: `TENANT#${context.tenantId}#SECRET`,
    SK: `SECRET#${name}#CURRENT`,
  };
}
function associatedData(
  context: TenantContext,
  name: string,
  version: string,
): Buffer {
  return Buffer.from(`${context.tenantId}\n${name}\n${version}`, "utf8");
}
export function decodeLocalMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new Error(
      "LOCAL_SECRET_MASTER_KEY_B64 must be a canonical base64 32-byte key.",
    );
  return key;
}
export class LocalDynamoDbSecretStore implements SecretStore {
  private readonly masterKey: Buffer;
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly config: LocalSecretStoreConfig,
  ) {
    this.masterKey = decodeLocalMasterKey(config.masterKeyBase64);
  }
  public async store(
    context: TenantContext,
    input: {
      readonly name: string;
      readonly value: string;
      readonly version?: string;
    },
  ): Promise<SecretReference> {
    const version = input.version ?? randomBytes(12).toString("base64url");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    cipher.setAAD(associatedData(context, input.name, version));
    const ciphertext = Buffer.concat([
      cipher.update(input.value, "utf8"),
      cipher.final(),
    ]);
    const record: SecretItem = {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      version,
    };
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.config.coreTableName,
              Item: {
                ...secretKey(context, input.name, version),
                entityType: "LOCAL_SECRET",
                ...record,
                createdAt: new Date().toISOString(),
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: this.config.coreTableName,
              Item: {
                ...secretHeadKey(context, input.name),
                entityType: "LOCAL_SECRET_HEAD",
                version,
                updatedAt: new Date().toISOString(),
              },
            },
          },
        ],
      }),
    );
    return { name: input.name, version };
  }
  public async resolve(
    context: TenantContext,
    reference: SecretReference,
  ): Promise<{ readonly value: string; readonly version?: string }> {
    let version = reference.version;
    if (version === undefined) {
      const head = await this.client.send(
        new GetCommand({
          TableName: this.config.coreTableName,
          Key: secretHeadKey(context, reference.name),
        }),
      );
      if (typeof head.Item?.version !== "string")
        throw new Error("Secret reference could not be resolved.");
      version = head.Item.version;
    }
    const response = await this.client.send(
      new GetCommand({
        TableName: this.config.coreTableName,
        Key: secretKey(context, reference.name, version),
      }),
    );
    if (response.Item === undefined)
      throw new Error("Secret reference could not be resolved.");
    const stored = response.Item as SecretItem;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.masterKey,
        Buffer.from(stored.iv, "base64"),
      );
      decipher.setAAD(associatedData(context, reference.name, version));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      const value = Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { value, version };
    } catch {
      throw new Error("Secret reference could not be resolved.");
    }
  }
  public async isBound(
    context: TenantContext,
    alias: string,
  ): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.config.coreTableName,
        Key: secretHeadKey(context, alias),
        ProjectionExpression: "#version",
        ExpressionAttributeNames: { "#version": "version" },
      }),
    );
    return typeof response.Item?.version === "string";
  }
}

/**
 * Hosted secret adapter. The parameter name is deliberately derived from the
 * tenant and logical alias only: parameter versions are SSM versions, not a
 * second namespace that can drift from the reference stored with the entity.
 */
export class SsmParameterSecretStore implements SecretStore {
  public constructor(
    private readonly client: SSMClient,
    private readonly prefix = "/pirh/demo/tenants",
  ) {}

  private name(context: TenantContext, alias: string): string {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(alias))
      throw new Error("Secret alias contains unsupported characters.");
    return `${this.prefix}/${context.tenantId}/secrets/${alias}`;
  }

  public async store(
    context: TenantContext,
    input: {
      readonly name: string;
      readonly value: string;
      readonly version?: string;
    },
  ): Promise<SecretReference> {
    if (input.version !== undefined)
      throw new Error("SSM assigns immutable secret versions.");
    const response = await this.client.send(
      new PutParameterCommand({
        Name: this.name(context, input.name),
        Value: input.value,
        Type: "SecureString",
        Overwrite: true,
        Tier: "Standard",
      }),
    );
    if (response.Version === undefined)
      throw new Error("Secret parameter version was not returned.");
    return { name: input.name, version: String(response.Version) };
  }

  public async resolve(
    context: TenantContext,
    reference: SecretReference,
  ): Promise<{ readonly value: string; readonly version?: string }> {
    const name = this.name(context, reference.name);
    const response = await this.client.send(
      new GetParameterCommand({
        Name:
          reference.version === undefined
            ? name
            : `${name}:${reference.version}`,
        WithDecryption: true,
      }),
    );
    if (
      response.Parameter?.Value === undefined ||
      response.Parameter.Version === undefined
    )
      throw new Error("Secret reference could not be resolved.");
    return {
      value: response.Parameter.Value,
      version: String(response.Parameter.Version),
    };
  }

  public async isBound(
    context: TenantContext,
    alias: string,
  ): Promise<boolean> {
    try {
      const response = await this.client.send(
        new GetParameterCommand({
          Name: this.name(context, alias),
          WithDecryption: false,
        }),
      );
      return response.Parameter?.Version !== undefined;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "ParameterNotFound"
      )
        return false;
      throw error;
    }
  }
}
