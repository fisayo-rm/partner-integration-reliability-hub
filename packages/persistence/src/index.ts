import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  ApiClient,
  AuditEvent,
  CanonicalEvent,
  DeliveryAttempt,
  DeliveryExecution,
  DeliveryHistoryEntry,
  Destination,
  EventId,
  OutboxRecord,
  Partner,
  Subscription,
  Tenant,
  TenantContext,
  TransformationVersion,
  UserIdentityMapping,
} from "@pirh/domain";
import type {
  ApiClientRepository,
  AtomicWriteSet,
  AuditRepository,
  CoreRepository,
  DeliveryConcurrencyRepository,
  EventAcceptanceWriter,
  IdentityRepository,
  NonceRepository,
  OutboxRepository,
  TenantRepository,
} from "@pirh/application";
import { key, stableShard } from "./keys.js";

export { key, stableShard } from "./keys.js";

type Item = Record<string, unknown>;
export interface DynamoPersistenceConfig {
  readonly coreTableName: string;
  readonly auditTableName: string;
  readonly outboxShardCount: number;
}
export function epochSeconds(value: Date | string): number {
  return Math.floor(
    (typeof value === "string" ? new Date(value) : value).getTime() / 1_000,
  );
}
export function isExpired(item: Item, now = new Date()): boolean {
  return (
    typeof item.expiresAt === "number" && item.expiresAt <= epochSeconds(now)
  );
}
function item<T>(value: Item | undefined): T | undefined {
  return value === undefined || isExpired(value) ? undefined : (value as T);
}
function itemWithKeys(
  value: object,
  keys: { readonly PK: string; readonly SK: string },
  entityType: string,
): Item {
  return { ...keys, entityType, ...(value as Item) };
}
function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "ConditionalCheckFailedException" ||
      error.name === "TransactionCanceledException")
  );
}

export class DynamoPersistence
  implements
    CoreRepository,
    AuditRepository,
    OutboxRepository,
    IdentityRepository,
    ApiClientRepository,
    TenantRepository,
    NonceRepository,
    EventAcceptanceWriter,
    DeliveryConcurrencyRepository
{
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly config: DynamoPersistenceConfig,
  ) {}

  public async getTenant(context: TenantContext): Promise<Tenant | undefined> {
    return this.getCore<Tenant>(key.tenant(context.tenantId));
  }
  public async findVerifiedIdentity(
    issuer: string,
    subject: string,
  ): Promise<UserIdentityMapping | undefined> {
    return this.getCore<UserIdentityMapping>(key.identity(issuer, subject));
  }
  public async locateClient(
    clientId: ApiClient["clientId"],
  ): Promise<{ readonly tenantId: TenantContext["tenantId"] } | undefined> {
    return this.getCore<{ readonly tenantId: TenantContext["tenantId"] }>(
      key.apiClientLocator(clientId),
    );
  }
  public async getClient(
    context: TenantContext,
    clientId: ApiClient["clientId"],
  ): Promise<ApiClient | undefined> {
    return this.getCore<ApiClient>(key.apiClient(context.tenantId, clientId));
  }
  public async getEvent(
    context: TenantContext,
    eventId: EventId,
  ): Promise<CanonicalEvent | undefined> {
    return this.getCore<CanonicalEvent>(key.event(context.tenantId, eventId));
  }
  public async getDelivery(
    context: TenantContext,
    deliveryId: DeliveryExecution["deliveryId"],
  ): Promise<DeliveryExecution | undefined> {
    const pointer = await this.getCore<{ readonly eventId: string }>(
      key.lookup(context.tenantId, "DELIVERY", deliveryId),
    );
    return pointer === undefined
      ? undefined
      : this.getCore<DeliveryExecution>(
          key.delivery(context.tenantId, pointer.eventId, deliveryId),
        );
  }
  public async getDestination(
    context: TenantContext,
    destinationId: Destination["destinationId"],
  ): Promise<Destination | undefined> {
    return this.getCore<Destination>(
      key.destination(context.tenantId, destinationId),
    );
  }
  public async getPartner(
    context: TenantContext,
    partnerId: Partner["partnerId"],
  ): Promise<Partner | undefined> {
    return this.getCore<Partner>(key.partner(context.tenantId, partnerId));
  }
  public async listSubscriptions(
    context: TenantContext,
    eventType: string,
  ): Promise<readonly Subscription[]> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${context.tenantId}#EVENT_TYPE#${eventType}`,
          ":prefix": "DESTINATION#",
        },
      }),
    );
    return (response.Items ?? [])
      .filter((value) => !isExpired(value))
      .map((value) => value as Subscription);
  }
  public async getTransformationVersion(
    context: TenantContext,
    transformationId: TransformationVersion["transformationId"],
    version: number,
  ): Promise<TransformationVersion | undefined> {
    return this.getCore<TransformationVersion>(
      key.transformation(context.tenantId, transformationId, version),
    );
  }
  public async append(event: AuditEvent): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.config.auditTableName,
        Item: itemWithKeys(
          { ...event, expiresAt: epochSeconds(event.expiresAt) },
          key.audit(event.tenantId, event.occurredAt, event.auditId),
          "AUDIT",
        ),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }
  public async list(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly items: readonly AuditEvent[];
    readonly cursor?: string;
  }> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.config.auditTableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${context.tenantId}` },
        Limit: input.limit,
      }),
    );
    const items = (result.Items ?? [])
      .filter((value) => !isExpired(value))
      .map((value) => value as AuditEvent);
    return result.LastEvaluatedKey === undefined
      ? { items }
      : { items, cursor: JSON.stringify(result.LastEvaluatedKey) };
  }
  public async getUnpublished(
    shard: number,
    olderThan: Date,
    limit: number,
  ): Promise<readonly OutboxRecord[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK < :before",
        ExpressionAttributeValues: {
          ":pk": `OUTBOX#UNPUBLISHED#${shard}`,
          ":before": olderThan.toISOString(),
        },
        Limit: limit,
      }),
    );
    return (result.Items ?? [])
      .filter((value) => !isExpired(value))
      .map((value) => value as OutboxRecord);
  }
  public async markPublished(
    outbox: Pick<OutboxRecord, "outboxId" | "createdAt">,
    publishedAt: Date,
  ): Promise<void> {
    const shard = stableShard(outbox.outboxId, this.config.outboxShardCount);
    await this.client.send(
      new UpdateCommand({
        TableName: this.config.coreTableName,
        Key: key.outbox(shard, outbox.createdAt, outbox.outboxId),
        UpdateExpression: "SET publishedAt = :published REMOVE GSI1PK, GSI1SK",
        ExpressionAttributeValues: { ":published": publishedAt.toISOString() },
      }),
    );
  }
  public async recordPublicationFailure(
    outbox: Pick<OutboxRecord, "outboxId" | "createdAt">,
    occurredAt: Date,
  ): Promise<void> {
    const shard = stableShard(outbox.outboxId, this.config.outboxShardCount);
    await this.client.send(
      new UpdateCommand({
        TableName: this.config.coreTableName,
        Key: key.outbox(shard, outbox.createdAt, outbox.outboxId),
        UpdateExpression:
          "ADD attempts :one SET lastPublicationFailureAt = :at",
        ExpressionAttributeValues: {
          ":one": 1,
          ":at": occurredAt.toISOString(),
        },
      }),
    );
  }
  public async putIfAbsent(input: {
    readonly tenantId: TenantContext["tenantId"];
    readonly clientId: ApiClient["clientId"];
    readonly nonceHash: string;
    readonly expiresAt: Date;
  }): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            { expiresAt: epochSeconds(input.expiresAt) },
            key.nonce(input.tenantId, input.clientId, input.nonceHash),
            "REQUEST_NONCE",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }
  public async accept(
    input: Parameters<EventAcceptanceWriter["accept"]>[0],
  ): Promise<"accepted" | "duplicate" | "conflict"> {
    const guardKey = key.idempotency(
      input.context.tenantId,
      input.event.producerClientId,
      input.idempotencyKeyHash,
    );
    const existing = await this.getCore<{ readonly requestBodyHash: string }>(
      guardKey,
    );
    if (existing !== undefined)
      return existing.requestBodyHash === input.requestBodyHash
        ? "duplicate"
        : "conflict";
    const eventKey = key.event(input.context.tenantId, input.event.eventId);
    const correlation = key.lookup(
      input.context.tenantId,
      "CORRELATION",
      input.event.correlationId,
    );
    const eventIndex = key.eventIndex(
      input.context.tenantId,
      "ALL",
      input.event.acceptedAt,
      input.event.eventId,
    );
    const shard = stableShard(
      input.outbox.outboxId,
      this.config.outboxShardCount,
    );
    const outboxKey = key.outbox(
      shard,
      input.outbox.createdAt,
      input.outbox.outboxId,
    );
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  {
                    ...input.event,
                    expiresAt: epochSeconds(input.event.expiresAt),
                  },
                  eventKey,
                  "EVENT",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  { eventId: input.event.eventId },
                  correlation,
                  "LOOKUP",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  {
                    eventId: input.event.eventId,
                    acceptedAt: input.event.acceptedAt,
                    expiresAt: epochSeconds(input.event.expiresAt),
                  },
                  eventIndex,
                  "EVENT_INDEX",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  {
                    requestBodyHash: input.requestBodyHash,
                    eventId: input.event.eventId,
                    responseStatus: input.responseStatus,
                    expiresAt: epochSeconds(
                      new Date(Date.now() + 7 * 86_400_000),
                    ),
                  },
                  guardKey,
                  "IDEMPOTENCY",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  {
                    ...input.outbox,
                    GSI1PK: `OUTBOX#UNPUBLISHED#${shard}`,
                    GSI1SK: `${input.outbox.createdAt}#${input.outbox.outboxId}`,
                  },
                  outboxKey,
                  "OUTBOX",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return "accepted";
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const raced = await this.getCore<{ readonly requestBodyHash: string }>(
        guardKey,
      );
      return raced?.requestBodyHash === input.requestBodyHash
        ? "duplicate"
        : "conflict";
    }
  }
  public async replaceIfVersion(
    context: TenantContext,
    delivery: DeliveryExecution,
    expectedVersion: number,
  ): Promise<boolean> {
    const existing = await this.getCore<{ readonly eventId: string }>(
      key.lookup(context.tenantId, "DELIVERY", delivery.deliveryId),
    );
    if (existing === undefined) return false;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            { ...delivery, expiresAt: epochSeconds(delivery.expiresAt) },
            key.delivery(
              context.tenantId,
              existing.eventId,
              delivery.deliveryId,
            ),
            "DELIVERY",
          ),
          ConditionExpression: "#version = :version",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":version": expectedVersion },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }
  public async appendAttemptAndHistory(
    context: TenantContext,
    eventId: EventId,
    attempt: DeliveryAttempt,
    history: DeliveryHistoryEntry,
  ): Promise<void> {
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.config.coreTableName,
              Item: itemWithKeys(
                attempt,
                key.attempt(
                  context.tenantId,
                  eventId,
                  attempt.deliveryId,
                  attempt.attemptNumber,
                ),
                "DELIVERY_ATTEMPT",
              ),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: this.config.coreTableName,
              Item: itemWithKeys(
                history,
                key.history(
                  context.tenantId,
                  eventId,
                  history.deliveryId,
                  history.occurredAt,
                  history.historyId,
                ),
                "DELIVERY_HISTORY",
              ),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  }
  public async acquireLease(
    input: Parameters<DeliveryConcurrencyRepository["acquireLease"]>[0],
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.config.coreTableName,
          Key: key.delivery(
            input.context.tenantId,
            input.eventId,
            input.deliveryId,
          ),
          UpdateExpression:
            "SET leaseOwner = :owner, leaseToken = :token, leaseExpiresAt = :expires, #version = #version + :one",
          ConditionExpression:
            "#version = :expected AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt < :now)",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: {
            ":owner": input.owner,
            ":token": input.token,
            ":expires": input.expiresAt,
            ":expected": input.expectedVersion,
            ":now": new Date().toISOString(),
            ":one": 1,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }
  public async putSeed(items: readonly Item[]): Promise<void> {
    for (const value of items)
      await this.client
        .send(
          new PutCommand({
            TableName: this.config.coreTableName,
            Item: value,
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        )
        .catch((error: unknown) => {
          if (!isConditionalFailure(error)) throw error;
        });
  }
  private async getCore<T>(keys: {
    readonly PK: string;
    readonly SK: string;
  }): Promise<T | undefined> {
    const response = await this.client.send(
      new GetCommand({ TableName: this.config.coreTableName, Key: keys }),
    );
    return item<T>(response.Item);
  }
}

/** A narrow implementation of the original port for M02 transaction tests and later services. */
export class DynamoAtomicWriter {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly config: DynamoPersistenceConfig,
  ) {}
  public async commit(
    _context: TenantContext,
    writeSet: AtomicWriteSet,
  ): Promise<void> {
    const core = writeSet.core.map((operation) => ({
      Put: {
        TableName: this.config.coreTableName,
        Item: operation.value as Item,
      },
    }));
    const audit = writeSet.audit.map((event) => ({
      Put: {
        TableName: this.config.auditTableName,
        Item: itemWithKeys(
          { ...event, expiresAt: epochSeconds(event.expiresAt) },
          key.audit(event.tenantId, event.occurredAt, event.auditId),
          "AUDIT",
        ),
      },
    }));
    const outbox = writeSet.outbox.map((record) => {
      const shard = stableShard(record.outboxId, this.config.outboxShardCount);
      return {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            {
              ...record,
              GSI1PK: `OUTBOX#UNPUBLISHED#${shard}`,
              GSI1SK: `${record.createdAt}#${record.outboxId}`,
            },
            key.outbox(shard, record.createdAt, record.outboxId),
            "OUTBOX",
          ),
        },
      };
    });
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [...core, ...audit, ...outbox],
      }),
    );
  }
}
