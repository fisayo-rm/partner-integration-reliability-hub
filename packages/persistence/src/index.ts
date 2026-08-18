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
  CircuitRuntimeState,
  RateLimitRuntimeState,
  ScheduledDeliveryWork,
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
  ControlPlaneRepository,
  DeliveryConcurrencyRepository,
  EventAcceptanceWriter,
  IdentityRepository,
  NonceRepository,
  OutboxRepository,
  RoutingRepository,
  TenantRepository,
} from "@pirh/application";
import {
  deriveEventStatus,
  isTerminalDeliveryState,
  rateLimitDecision,
  transitionDelivery,
} from "@pirh/domain";
import { key, stableShard } from "./keys.js";

export { key, stableShard } from "./keys.js";

type Item = Record<string, unknown>;
export interface DynamoPersistenceConfig {
  readonly coreTableName: string;
  readonly auditTableName: string;
  readonly outboxShardCount: number;
}
export function epochSeconds(value: Date | string | number): number {
  if (typeof value === "number") return value;
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
function deliveryIndexItem(
  delivery: DeliveryExecution,
  category: string,
): Item {
  return itemWithKeys(
    {
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      correlationId: delivery.correlationId,
      destinationId: delivery.destinationId,
      partnerId: delivery.partnerId,
      state: delivery.state,
      ...(delivery.blockedReason === undefined
        ? {}
        : { blockedReason: delivery.blockedReason }),
      updatedAt: delivery.updatedAt,
      expiresAt: epochSeconds(delivery.expiresAt),
    },
    key.deliveryIndex(
      delivery.tenantId,
      category,
      delivery.updatedAt,
      delivery.deliveryId,
    ),
    "DELIVERY_INDEX",
  );
}
function deliveryIndexCategories(
  delivery: DeliveryExecution,
): readonly string[] {
  return [
    "ALL",
    `STATUS#${delivery.state}`,
    `PARTNER#${delivery.partnerId}`,
    `DESTINATION#${delivery.destinationId}`,
  ];
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
    DeliveryConcurrencyRepository,
    RoutingRepository,
    ControlPlaneRepository
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
  public async listPartners(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<{ readonly items: readonly Partner[]; readonly cursor?: string }> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${context.tenantId}`,
          ":prefix": "PARTNER#",
        },
        Limit: input.limit,
        ExclusiveStartKey:
          input.cursor === undefined ? undefined : JSON.parse(input.cursor),
      }),
    );
    const items = (result.Items ?? [])
      .filter((value) => !isExpired(value))
      .map((value) => value as Partner);
    return result.LastEvaluatedKey === undefined
      ? { items }
      : { items, cursor: JSON.stringify(result.LastEvaluatedKey) };
  }
  public async listControlSubscriptions(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly items: readonly Subscription[];
    readonly cursor?: string;
  }> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${context.tenantId}`,
          ":prefix": "SUBSCRIPTION#",
        },
        Limit: input.limit,
        ExclusiveStartKey:
          input.cursor === undefined ? undefined : JSON.parse(input.cursor),
      }),
    );
    const items = (result.Items ?? [])
      .filter((value) => !isExpired(value))
      .map((value) => value as Subscription);
    return result.LastEvaluatedKey === undefined
      ? { items }
      : { items, cursor: JSON.stringify(result.LastEvaluatedKey) };
  }
  public async listTransformationVersions(
    context: TenantContext,
    transformationId: TransformationVersion["transformationId"],
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly items: readonly TransformationVersion[];
    readonly cursor?: string;
  }> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${context.tenantId}#TRANSFORMATION#${transformationId}`,
          ":prefix": "VERSION#",
        },
        Limit: input.limit,
        ExclusiveStartKey:
          input.cursor === undefined ? undefined : JSON.parse(input.cursor),
      }),
    );
    const items = (result.Items ?? [])
      .filter((value) => !isExpired(value))
      .map((value) => value as TransformationVersion);
    return result.LastEvaluatedKey === undefined
      ? { items }
      : { items, cursor: JSON.stringify(result.LastEvaluatedKey) };
  }
  private auditPut(event: AuditEvent) {
    return {
      Put: {
        TableName: this.config.auditTableName,
        Item: itemWithKeys(
          { ...event, expiresAt: epochSeconds(event.expiresAt) },
          key.audit(event.tenantId, event.occurredAt, event.auditId),
          "AUDIT",
        ),
        ConditionExpression: "attribute_not_exists(PK)",
      },
    };
  }
  private async controlWrite(
    items: readonly unknown[],
  ): Promise<"ok" | "conflict"> {
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items as never }),
      );
      return "ok";
    } catch (error) {
      if (isConditionalFailure(error)) return "conflict";
      throw error;
    }
  }
  public async createPartner(
    context: TenantContext,
    partner: Partner,
    audit: AuditEvent,
  ): Promise<"created" | "conflict" | "limit"> {
    const existing = await this.listPartners(context, { limit: 11 });
    if (existing.items.length >= 10) return "limit";
    const result = await this.controlWrite([
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            partner,
            key.partner(context.tenantId, partner.partnerId),
            "PARTNER",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            { partnerId: partner.partnerId },
            key.externalKey(context.tenantId, "PARTNER", partner.externalKey),
            "EXTERNAL_KEY",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      this.auditPut(audit),
    ]);
    return result === "ok" ? "created" : "conflict";
  }
  public async updatePartner(
    context: TenantContext,
    partner: Partner,
    expectedVersion: number,
    audit: AuditEvent,
  ): Promise<"updated" | "not_found" | "conflict"> {
    if ((await this.getPartner(context, partner.partnerId)) === undefined)
      return "not_found";
    const result = await this.controlWrite([
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            partner,
            key.partner(context.tenantId, partner.partnerId),
            "PARTNER",
          ),
          ConditionExpression: "#version = :version",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":version": expectedVersion },
        },
      },
      this.auditPut(audit),
    ]);
    return result === "ok" ? "updated" : "conflict";
  }
  public async createDestination(
    context: TenantContext,
    destination: Destination,
    audit: AuditEvent,
  ): Promise<"created" | "conflict" | "limit" | "not_found"> {
    if ((await this.getPartner(context, destination.partnerId)) === undefined)
      return "not_found";
    const existing = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${context.tenantId}`,
          ":prefix": "DESTINATION#",
        },
        Select: "COUNT",
      }),
    );
    if ((existing.Count ?? 0) >= 25) return "limit";
    const result = await this.controlWrite([
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            destination,
            key.destination(context.tenantId, destination.destinationId),
            "DESTINATION",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            { destinationId: destination.destinationId },
            key.externalKey(
              context.tenantId,
              "DESTINATION",
              destination.externalKey,
            ),
            "EXTERNAL_KEY",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      this.auditPut(audit),
    ]);
    return result === "ok" ? "created" : "conflict";
  }
  public async updateDestination(
    context: TenantContext,
    destination: Destination,
    expectedVersion: number,
    audit: AuditEvent,
    outbox?: OutboxRecord,
  ): Promise<"updated" | "not_found" | "conflict"> {
    if (
      (await this.getDestination(context, destination.destinationId)) ===
      undefined
    )
      return "not_found";
    const records: unknown[] = [
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            destination,
            key.destination(context.tenantId, destination.destinationId),
            "DESTINATION",
          ),
          ConditionExpression: "#version = :version",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":version": expectedVersion },
        },
      },
      this.auditPut(audit),
    ];
    if (outbox !== undefined) {
      const shard = stableShard(outbox.outboxId, this.config.outboxShardCount);
      records.push({
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            {
              ...outbox,
              expiresAt: epochSeconds(
                new Date(new Date(outbox.createdAt).getTime() + 7 * 86_400_000),
              ),
              GSI1PK: `OUTBOX#UNPUBLISHED#${shard}`,
              GSI1SK: `${outbox.createdAt}#${outbox.outboxId}`,
            },
            key.outbox(shard, outbox.createdAt, outbox.outboxId),
            "OUTBOX",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    }
    const result = await this.controlWrite(records);
    return result === "ok" ? "updated" : "conflict";
  }
  public async createTransformationVersion(
    context: TenantContext,
    transformation: TransformationVersion,
    audit: AuditEvent,
  ): Promise<"created" | "conflict"> {
    const items: unknown[] = [
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            transformation,
            key.transformation(
              context.tenantId,
              transformation.transformationId,
              transformation.version,
            ),
            "TRANSFORMATION_VERSION",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      this.auditPut(audit),
    ];
    if (transformation.version === 1)
      items.splice(1, 0, {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            { transformationId: transformation.transformationId },
            key.externalKey(
              context.tenantId,
              "TRANSFORMATION",
              transformation.externalKey,
            ),
            "EXTERNAL_KEY",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      });
    return (await this.controlWrite(items)) === "ok" ? "created" : "conflict";
  }
  public async createSubscription(
    context: TenantContext,
    subscription: Subscription,
    audit: AuditEvent,
  ): Promise<"created" | "conflict" | "not_found"> {
    if (
      (await this.getDestination(context, subscription.destinationId)) ===
      undefined
    )
      return "not_found";
    const result = await this.controlWrite([
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            subscription,
            key.subscription(
              context.tenantId,
              subscription.eventType,
              subscription.destinationId,
            ),
            "SUBSCRIPTION",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            subscription,
            key.subscriptionCatalog(
              context.tenantId,
              subscription.subscriptionId,
            ),
            "SUBSCRIPTION_CATALOG",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      {
        Put: {
          TableName: this.config.coreTableName,
          Item: itemWithKeys(
            { subscriptionId: subscription.subscriptionId },
            key.externalKey(
              context.tenantId,
              "SUBSCRIPTION",
              subscription.externalKey,
            ),
            "EXTERNAL_KEY",
          ),
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
      this.auditPut(audit),
    ]);
    return result === "ok" ? "created" : "conflict";
  }
  public async deleteSubscription(
    context: TenantContext,
    subscriptionId: Subscription["subscriptionId"],
    audit: AuditEvent,
  ): Promise<"deleted" | "not_found"> {
    const subscription = await this.getCore<Subscription>(
      key.subscriptionCatalog(context.tenantId, subscriptionId),
    );
    if (subscription === undefined) return "not_found";
    const result = await this.controlWrite([
      {
        Delete: {
          TableName: this.config.coreTableName,
          Key: key.subscription(
            context.tenantId,
            subscription.eventType,
            subscription.destinationId,
          ),
          ConditionExpression: "attribute_exists(PK)",
        },
      },
      {
        Delete: {
          TableName: this.config.coreTableName,
          Key: key.subscriptionCatalog(context.tenantId, subscriptionId),
          ConditionExpression: "attribute_exists(PK)",
        },
      },
      {
        Delete: {
          TableName: this.config.coreTableName,
          Key: key.externalKey(
            context.tenantId,
            "SUBSCRIPTION",
            subscription.externalKey,
          ),
        },
      },
      this.auditPut(audit),
    ]);
    return result === "ok" ? "deleted" : "not_found";
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
  public async materializeScheduledWork(record: OutboxRecord): Promise<void> {
    const payload = record.payload as Record<string, unknown>;
    if (
      typeof payload.eventId !== "string" ||
      typeof payload.deliveryId !== "string" ||
      typeof payload.correlationId !== "string" ||
      typeof payload.notBefore !== "string" ||
      (payload.cause !== "RETRY" && payload.cause !== "RESUME")
    )
      throw new Error("INVALID_SCHEDULE_OUTBOX");
    const shard = stableShard(record.outboxId, this.config.outboxShardCount);
    const work: ScheduledDeliveryWork = {
      workId: record.outboxId,
      tenantId: record.tenantId,
      eventId: payload.eventId as never,
      deliveryId: payload.deliveryId as never,
      correlationId: payload.correlationId as never,
      notBefore: payload.notBefore as never,
      cause: payload.cause,
      createdAt: record.createdAt,
      attempts: 0,
      expiresAt: new Date(
        new Date(record.createdAt).getTime() + 7 * 86_400_000,
      ).toISOString() as never,
      schemaVersion: 1,
    };
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.config.coreTableName,
              Item: itemWithKeys(
                { ...work, expiresAt: epochSeconds(work.expiresAt) },
                key.scheduledWork(shard, work.notBefore, work.workId),
                "SCHEDULED_WORK",
              ),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Update: {
              TableName: this.config.coreTableName,
              Key: key.outbox(shard, record.createdAt, record.outboxId),
              UpdateExpression:
                "SET publishedAt = :published REMOVE GSI1PK, GSI1SK",
              ExpressionAttributeValues: {
                ":published": new Date().toISOString(),
              },
            },
          },
        ],
      }),
    );
  }
  public async getDueScheduledWork(
    shard: number,
    now: Date,
    limit: number,
  ): Promise<readonly ScheduledDeliveryWork[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        KeyConditionExpression: "PK = :pk AND SK < :before",
        ExpressionAttributeValues: {
          ":pk": `SCHEDULED_WORK#${shard}`,
          ":before": `${now.toISOString()}#~`,
        },
        Limit: limit,
      }),
    );
    return (result.Items ?? [])
      .filter((value) => !isExpired(value) && value.publishedAt === undefined)
      .map((value) => value as ScheduledDeliveryWork);
  }
  public async markScheduledWorkPublished(
    work: Pick<ScheduledDeliveryWork, "workId" | "notBefore">,
    publishedAt: Date,
  ): Promise<void> {
    const shard = stableShard(work.workId, this.config.outboxShardCount);
    await this.client.send(
      new UpdateCommand({
        TableName: this.config.coreTableName,
        Key: key.scheduledWork(shard, work.notBefore, work.workId),
        UpdateExpression: "SET publishedAt = :published ADD attempts :one",
        ExpressionAttributeValues: {
          ":published": publishedAt.toISOString(),
          ":one": 1,
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
  ): Promise<Awaited<ReturnType<EventAcceptanceWriter["accept"]>>> {
    const guardKey = key.idempotency(
      input.context.tenantId,
      input.event.producerClientId,
      input.idempotencyKeyHash,
    );
    const existing = await this.getCore<{
      readonly requestBodyHash: string;
      readonly eventId: EventId;
    }>(guardKey);
    if (existing !== undefined) {
      if (existing.requestBodyHash !== input.requestBodyHash)
        return { kind: "conflict" };
      const event = await this.getEvent(input.context, existing.eventId);
      return event === undefined
        ? { kind: "conflict" }
        : { kind: "duplicate", event };
    }
    const eventKey = key.event(input.context.tenantId, input.event.eventId);
    const correlation = key.lookup(
      input.context.tenantId,
      "CORRELATION",
      input.event.correlationId,
    );
    const eventLookup = key.lookup(
      input.context.tenantId,
      "EVENT",
      input.event.eventId,
    );
    const eventIndex = key.eventIndex(
      input.context.tenantId,
      "ALL",
      input.event.acceptedAt,
      input.event.eventId,
    );
    const eventTypeIndex = key.eventIndex(
      input.context.tenantId,
      `TYPE#${input.event.eventType}`,
      input.event.acceptedAt,
      input.event.eventId,
    );
    const eventStatusIndex = key.eventIndex(
      input.context.tenantId,
      `STATUS#${input.event.status}`,
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
                  eventLookup,
                  "LOOKUP",
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
                    eventType: input.event.eventType,
                    acceptedAt: input.event.acceptedAt,
                    expiresAt: epochSeconds(input.event.expiresAt),
                  },
                  eventTypeIndex,
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
                    eventId: input.event.eventId,
                    status: input.event.status,
                    acceptedAt: input.event.acceptedAt,
                    expiresAt: epochSeconds(input.event.expiresAt),
                  },
                  eventStatusIndex,
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
                    expiresAt: epochSeconds(
                      new Date(
                        new Date(input.outbox.createdAt).getTime() +
                          7 * 86_400_000,
                      ),
                    ),
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
      return { kind: "accepted", event: input.event };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const raced = await this.getCore<{
        readonly requestBodyHash: string;
        readonly eventId: EventId;
      }>(guardKey);
      if (raced?.requestBodyHash !== input.requestBodyHash)
        return { kind: "conflict" };
      const event = await this.getEvent(input.context, raced.eventId);
      return event === undefined
        ? { kind: "conflict" }
        : { kind: "duplicate", event };
    }
  }
  public async createDelivery(
    input: Parameters<RoutingRepository["createDelivery"]>[0],
  ): Promise<"created" | "duplicate"> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.getCore<{ readonly eventId: EventId }>(
        key.lookup(
          input.context.tenantId,
          "DELIVERY",
          input.delivery.deliveryId,
        ),
      );
      if (existing !== undefined) return "duplicate";
      const event = await this.getEvent(input.context, input.delivery.eventId);
      if (event === undefined) throw new Error("EVENT_NOT_FOUND");
      const terminal = isTerminalDeliveryState(input.delivery.state);
      const outcome = {
        ...event.outcome,
        totalDeliveries: event.outcome.totalDeliveries + 1,
        terminalDeliveries:
          event.outcome.terminalDeliveries + (terminal ? 1 : 0),
        successfulDeliveries:
          event.outcome.successfulDeliveries +
          (input.delivery.state === "succeeded" ? 1 : 0),
        failedTerminalDeliveries:
          event.outcome.failedTerminalDeliveries +
          (input.delivery.state === "failed_terminal" ? 1 : 0),
        deadLetteredDeliveries:
          event.outcome.deadLetteredDeliveries +
          (input.delivery.state === "dead_lettered" ? 1 : 0),
      };
      const updatedEvent: CanonicalEvent = {
        ...event,
        outcome,
        status: deriveEventStatus(outcome),
        version: event.version + 1,
      };
      const transaction: unknown[] = [
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...input.delivery,
                expiresAt: epochSeconds(input.delivery.expiresAt),
              },
              key.delivery(
                input.context.tenantId,
                input.delivery.eventId,
                input.delivery.deliveryId,
              ),
              "DELIVERY",
            ),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              { eventId: input.delivery.eventId },
              key.lookup(
                input.context.tenantId,
                "DELIVERY",
                input.delivery.deliveryId,
              ),
              "LOOKUP",
            ),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              input.history,
              key.history(
                input.context.tenantId,
                input.delivery.eventId,
                input.history.deliveryId,
                input.history.occurredAt,
                input.history.historyId,
              ),
              "DELIVERY_HISTORY",
            ),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...deliveryIndexCategories(input.delivery).map((category) => ({
          Put: {
            TableName: this.config.coreTableName,
            Item: deliveryIndexItem(input.delivery, category),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        })),
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...updatedEvent,
                expiresAt: epochSeconds(updatedEvent.expiresAt),
              },
              key.event(input.context.tenantId, updatedEvent.eventId),
              "EVENT",
            ),
            ConditionExpression: "#version = :version",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": event.version },
          },
        },
      ];
      if (event.status !== updatedEvent.status) {
        transaction.push({
          Delete: {
            TableName: this.config.coreTableName,
            Key: key.eventIndex(
              input.context.tenantId,
              `STATUS#${event.status}`,
              event.acceptedAt,
              event.eventId,
            ),
          },
        });
        transaction.push({
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                eventId: updatedEvent.eventId,
                status: updatedEvent.status,
                acceptedAt: updatedEvent.acceptedAt,
                expiresAt: epochSeconds(updatedEvent.expiresAt),
              },
              key.eventIndex(
                input.context.tenantId,
                `STATUS#${updatedEvent.status}`,
                updatedEvent.acceptedAt,
                updatedEvent.eventId,
              ),
              "EVENT_INDEX",
            ),
          },
        });
      }
      if (input.outbox !== undefined) {
        const shard = stableShard(
          input.outbox.outboxId,
          this.config.outboxShardCount,
        );
        transaction.push({
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...input.outbox,
                expiresAt: epochSeconds(
                  new Date(
                    new Date(input.outbox.createdAt).getTime() + 7 * 86_400_000,
                  ),
                ),
                GSI1PK: `OUTBOX#UNPUBLISHED#${shard}`,
                GSI1SK: `${input.outbox.createdAt}#${input.outbox.outboxId}`,
              },
              key.outbox(shard, input.outbox.createdAt, input.outbox.outboxId),
              "OUTBOX",
            ),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        });
      }
      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: transaction as never }),
        );
        return "created";
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    throw new Error("ROUTING_CONFLICT");
  }
  public async completeRouting(
    context: TenantContext,
    eventId: EventId,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const event = await this.getEvent(context, eventId);
      if (event === undefined || event.outcome.routingComplete) return;
      const outcome = { ...event.outcome, routingComplete: true };
      const updated: CanonicalEvent = {
        ...event,
        outcome,
        status: deriveEventStatus(outcome),
        version: event.version + 1,
      };
      const transaction: unknown[] = [
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              { ...updated, expiresAt: epochSeconds(updated.expiresAt) },
              key.event(context.tenantId, event.eventId),
              "EVENT",
            ),
            ConditionExpression: "#version = :version",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": event.version },
          },
        },
      ];
      if (event.status !== updated.status) {
        transaction.push({
          Delete: {
            TableName: this.config.coreTableName,
            Key: key.eventIndex(
              context.tenantId,
              `STATUS#${event.status}`,
              event.acceptedAt,
              event.eventId,
            ),
          },
        });
        transaction.push({
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                eventId: updated.eventId,
                status: updated.status,
                acceptedAt: updated.acceptedAt,
                expiresAt: epochSeconds(updated.expiresAt),
              },
              key.eventIndex(
                context.tenantId,
                `STATUS#${updated.status}`,
                updated.acceptedAt,
                updated.eventId,
              ),
              "EVENT_INDEX",
            ),
          },
        });
      }
      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: transaction as never }),
        );
        return;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    throw new Error("ROUTING_COMPLETION_CONFLICT");
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
  ): Promise<DeliveryExecution | undefined> {
    try {
      const response = await this.client.send(
        new UpdateCommand({
          TableName: this.config.coreTableName,
          Key: key.delivery(
            input.context.tenantId,
            input.eventId,
            input.deliveryId,
          ),
          UpdateExpression:
            "SET leaseOwner = :owner, leaseToken = :token, leaseAcquiredAt = :now, leaseExpiresAt = :expires, #state = :inProgress, #version = #version + :one",
          ConditionExpression:
            "#version = :expected AND ((#state = :scheduled OR #state = :retry OR #state = :rate) AND (attribute_not_exists(nextEligibleAt) OR nextEligibleAt <= :now))",
          ExpressionAttributeNames: {
            "#version": "version",
            "#state": "state",
          },
          ExpressionAttributeValues: {
            ":owner": input.owner,
            ":token": input.token,
            ":expires": input.expiresAt,
            ":expected": input.expectedVersion,
            ":now": new Date().toISOString(),
            ":scheduled": "scheduled",
            ":retry": "retry_scheduled",
            ":rate": "rate_limited",
            ":inProgress": "in_progress",
            ":one": 1,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return response.Attributes as DeliveryExecution | undefined;
    } catch (error) {
      if (isConditionalFailure(error)) return undefined;
      throw error;
    }
  }
  public async finalizeSuccess(
    input: Parameters<DeliveryConcurrencyRepository["finalizeSuccess"]>[0],
  ): Promise<boolean> {
    for (let retry = 0; retry < 8; retry += 1) {
      const current = await this.getCore<DeliveryExecution>(
        key.delivery(
          input.context.tenantId,
          input.eventId,
          input.delivery.deliveryId,
        ),
      );
      const event = await this.getEvent(input.context, input.eventId);
      if (current === undefined || event === undefined) return false;
      const outcome = {
        ...event.outcome,
        terminalDeliveries: event.outcome.terminalDeliveries + 1,
        successfulDeliveries: event.outcome.successfulDeliveries + 1,
      };
      const updatedEvent: CanonicalEvent = {
        ...event,
        outcome,
        status: deriveEventStatus(outcome),
        version: event.version + 1,
      };
      const transaction: unknown[] = [
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...input.delivery,
                expiresAt: epochSeconds(input.delivery.expiresAt),
              },
              key.delivery(
                input.context.tenantId,
                input.eventId,
                input.delivery.deliveryId,
              ),
              "DELIVERY",
            ),
            ConditionExpression: "#version = :version AND leaseToken = :lease",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: {
              ":version": input.expectedVersion,
              ":lease": current.leaseToken,
            },
          },
        },
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              input.attempt,
              key.attempt(
                input.context.tenantId,
                input.eventId,
                input.attempt.deliveryId,
                input.attempt.attemptNumber,
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
              input.history,
              key.history(
                input.context.tenantId,
                input.eventId,
                input.history.deliveryId,
                input.history.occurredAt,
                input.history.historyId,
              ),
              "DELIVERY_HISTORY",
            ),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...deliveryIndexCategories(current).map((category) => ({
          Delete: {
            TableName: this.config.coreTableName,
            Key: key.deliveryIndex(
              current.tenantId,
              category,
              current.updatedAt,
              current.deliveryId,
            ),
          },
        })),
        ...deliveryIndexCategories(input.delivery).map((category) => ({
          Put: {
            TableName: this.config.coreTableName,
            Item: deliveryIndexItem(input.delivery, category),
          },
        })),
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...updatedEvent,
                expiresAt: epochSeconds(updatedEvent.expiresAt),
              },
              key.event(input.context.tenantId, input.eventId),
              "EVENT",
            ),
            ConditionExpression: "#version = :version",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": event.version },
          },
        },
      ];
      if (event.status !== updatedEvent.status) {
        transaction.push({
          Delete: {
            TableName: this.config.coreTableName,
            Key: key.eventIndex(
              input.context.tenantId,
              `STATUS#${event.status}`,
              event.acceptedAt,
              event.eventId,
            ),
          },
        });
        transaction.push({
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                eventId: updatedEvent.eventId,
                status: updatedEvent.status,
                acceptedAt: updatedEvent.acceptedAt,
                expiresAt: epochSeconds(updatedEvent.expiresAt),
              },
              key.eventIndex(
                input.context.tenantId,
                `STATUS#${updatedEvent.status}`,
                updatedEvent.acceptedAt,
                updatedEvent.eventId,
              ),
              "EVENT_INDEX",
            ),
          },
        });
      }
      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: transaction as never }),
        );
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    return false;
  }
  public async startAttempt(
    input: Parameters<DeliveryConcurrencyRepository["startAttempt"]>[0],
  ): Promise<DeliveryExecution | undefined> {
    const started: DeliveryExecution = {
      ...input.delivery,
      attemptCount: input.attempt.attemptNumber,
      activeAttemptId: input.attempt.attemptId,
      version: input.delivery.version + 1,
      updatedAt: input.attempt.startedAt,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  { ...started, expiresAt: epochSeconds(started.expiresAt) },
                  key.delivery(
                    input.context.tenantId,
                    input.eventId,
                    started.deliveryId,
                  ),
                  "DELIVERY",
                ),
                ConditionExpression:
                  "#version = :version AND leaseToken = :lease AND attribute_not_exists(activeAttemptId)",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: {
                  ":version": input.expectedVersion,
                  ":lease": input.delivery.leaseToken,
                },
              },
            },
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  {
                    ...input.attempt,
                    expiresAt: epochSeconds(input.attempt.expiresAt),
                  },
                  key.attempt(
                    input.context.tenantId,
                    input.eventId,
                    input.attempt.deliveryId,
                    input.attempt.attemptNumber,
                  ),
                  "DELIVERY_ATTEMPT",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
      return started;
    } catch (error) {
      if (isConditionalFailure(error)) return undefined;
      throw error;
    }
  }
  public async finalizeAttempt(
    input: Parameters<DeliveryConcurrencyRepository["finalizeAttempt"]>[0],
  ): Promise<boolean> {
    for (let retry = 0; retry < 8; retry += 1) {
      const current = await this.getCore<DeliveryExecution>(
        key.delivery(
          input.context.tenantId,
          input.eventId,
          input.delivery.deliveryId,
        ),
      );
      const event = await this.getEvent(input.context, input.eventId);
      if (current === undefined || event === undefined) return false;
      const terminal = isTerminalDeliveryState(input.delivery.state);
      const outcome = terminal
        ? {
            ...event.outcome,
            terminalDeliveries: event.outcome.terminalDeliveries + 1,
            successfulDeliveries:
              event.outcome.successfulDeliveries +
              (input.delivery.state === "succeeded" ? 1 : 0),
            failedTerminalDeliveries:
              event.outcome.failedTerminalDeliveries +
              (input.delivery.state === "failed_terminal" ? 1 : 0),
            deadLetteredDeliveries:
              event.outcome.deadLetteredDeliveries +
              (input.delivery.state === "dead_lettered" ? 1 : 0),
          }
        : event.outcome;
      const updatedEvent: CanonicalEvent = terminal
        ? {
            ...event,
            outcome,
            status: deriveEventStatus(outcome),
            version: event.version + 1,
          }
        : event;
      const finalDelivery = { ...input.delivery } as Record<string, unknown>;
      delete finalDelivery.activeAttemptId;
      const transaction: unknown[] = [
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...finalDelivery,
                expiresAt: epochSeconds(input.delivery.expiresAt),
              },
              key.delivery(
                input.context.tenantId,
                input.eventId,
                input.delivery.deliveryId,
              ),
              "DELIVERY",
            ),
            ConditionExpression:
              "#version = :version AND leaseToken = :lease AND activeAttemptId = :attempt",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: {
              ":version": input.expectedVersion,
              ":lease": input.leaseToken,
              ":attempt": input.attempt.attemptId,
            },
          },
        },
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...input.attempt,
                expiresAt: epochSeconds(input.attempt.expiresAt),
              },
              key.attempt(
                input.context.tenantId,
                input.eventId,
                input.attempt.deliveryId,
                input.attempt.attemptNumber,
              ),
              "DELIVERY_ATTEMPT",
            ),
            ConditionExpression: "#outcome = :started",
            ExpressionAttributeNames: { "#outcome": "outcome" },
            ExpressionAttributeValues: { ":started": "started" },
          },
        },
        {
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...input.history,
                expiresAt: epochSeconds(input.history.expiresAt),
              },
              key.history(
                input.context.tenantId,
                input.eventId,
                input.history.deliveryId,
                input.history.occurredAt,
                input.history.historyId,
              ),
              "DELIVERY_HISTORY",
            ),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        ...deliveryIndexCategories(current).map((category) => ({
          Delete: {
            TableName: this.config.coreTableName,
            Key: key.deliveryIndex(
              current.tenantId,
              category,
              current.updatedAt,
              current.deliveryId,
            ),
          },
        })),
        ...deliveryIndexCategories(input.delivery).map((category) => ({
          Put: {
            TableName: this.config.coreTableName,
            Item: deliveryIndexItem(input.delivery, category),
          },
        })),
      ];
      if (terminal) {
        transaction.push({
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...updatedEvent,
                expiresAt: epochSeconds(updatedEvent.expiresAt),
              },
              key.event(input.context.tenantId, input.eventId),
              "EVENT",
            ),
            ConditionExpression: "#version = :version",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": event.version },
          },
        });
      }
      if (input.outbox !== undefined) {
        const shard = stableShard(
          input.outbox.outboxId,
          this.config.outboxShardCount,
        );
        transaction.push({
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              {
                ...input.outbox,
                expiresAt: epochSeconds(
                  new Date(
                    new Date(input.outbox.createdAt).getTime() + 7 * 86_400_000,
                  ),
                ),
                GSI1PK: `OUTBOX#UNPUBLISHED#${shard}`,
                GSI1SK: `${input.outbox.createdAt}#${input.outbox.outboxId}`,
              },
              key.outbox(shard, input.outbox.createdAt, input.outbox.outboxId),
              "OUTBOX",
            ),
            ConditionExpression: "attribute_not_exists(PK)",
          },
        });
      }
      if (input.circuit !== undefined) {
        transaction.push({
          Put: {
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              input.circuit,
              key.runtime(
                input.context.tenantId,
                input.delivery.destinationId,
                "CIRCUIT",
              ),
              "CIRCUIT_RUNTIME",
            ),
            ConditionExpression:
              "attribute_not_exists(PK) OR #version = :version",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: {
              ":version": Math.max(0, input.circuit.version - 1),
            },
          },
        });
      }
      try {
        await this.client.send(
          new TransactWriteCommand({ TransactItems: transaction as never }),
        );
        return true;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    return false;
  }
  public async defer(
    input: Parameters<DeliveryConcurrencyRepository["defer"]>[0],
  ): Promise<boolean> {
    const shard = stableShard(
      input.outbox.outboxId,
      this.config.outboxShardCount,
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
                    ...input.delivery,
                    expiresAt: epochSeconds(input.delivery.expiresAt),
                  },
                  key.delivery(
                    input.context.tenantId,
                    input.eventId,
                    input.delivery.deliveryId,
                  ),
                  "DELIVERY",
                ),
                ConditionExpression:
                  "#version = :version AND leaseToken = :lease",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: {
                  ":version": input.expectedVersion,
                  ":lease": input.leaseToken,
                },
              },
            },
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  {
                    ...input.history,
                    expiresAt: epochSeconds(input.history.expiresAt),
                  },
                  key.history(
                    input.context.tenantId,
                    input.eventId,
                    input.history.deliveryId,
                    input.history.occurredAt,
                    input.history.historyId,
                  ),
                  "DELIVERY_HISTORY",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            ...deliveryIndexCategories(input.delivery).map((category) => ({
              Put: {
                TableName: this.config.coreTableName,
                Item: deliveryIndexItem(input.delivery, category),
              },
            })),
            {
              Put: {
                TableName: this.config.coreTableName,
                Item: itemWithKeys(
                  {
                    ...input.outbox,
                    expiresAt: epochSeconds(
                      new Date(
                        new Date(input.outbox.createdAt).getTime() +
                          7 * 86_400_000,
                      ),
                    ),
                    GSI1PK: `OUTBOX#UNPUBLISHED#${shard}`,
                    GSI1SK: `${input.outbox.createdAt}#${input.outbox.outboxId}`,
                  },
                  key.outbox(
                    shard,
                    input.outbox.createdAt,
                    input.outbox.outboxId,
                  ),
                  "OUTBOX",
                ),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ] as never,
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }
  public async acquireRatePermit(
    input: Parameters<DeliveryConcurrencyRepository["acquireRatePermit"]>[0],
  ): Promise<{ readonly permitted: boolean; readonly nextEligibleAt: Date }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.getCore<RateLimitRuntimeState>(
        key.runtime(input.context.tenantId, input.destinationId, "RATE_LIMIT"),
      );
      const decision = rateLimitDecision({
        ...(current === undefined ? {} : { state: current }),
        policy: input.policy,
        nowMs: input.now.getTime(),
      });
      if (!decision.permitted)
        return {
          permitted: false,
          nextEligibleAt: new Date(decision.nextEligibleAtMs),
        };
      const next: RateLimitRuntimeState = {
        theoreticalArrivalTimeMs:
          decision.nextTheoreticalArrivalTimeMs ?? input.now.getTime(),
        updatedAt: input.now.toISOString() as never,
        policyHash: JSON.stringify(input.policy),
        version: (current?.version ?? 0) + 1,
      };
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              next,
              key.runtime(
                input.context.tenantId,
                input.destinationId,
                "RATE_LIMIT",
              ),
              "RATE_LIMIT_RUNTIME",
            ),
            ConditionExpression:
              "attribute_not_exists(PK) OR #version = :version",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": current?.version ?? 0 },
          }),
        );
        return { permitted: true, nextEligibleAt: input.now };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    return {
      permitted: false,
      nextEligibleAt: new Date(input.now.getTime() + 5_000),
    };
  }
  public async acquireCircuitPermit(
    input: Parameters<DeliveryConcurrencyRepository["acquireCircuitPermit"]>[0],
  ): Promise<{
    readonly allowed: boolean;
    readonly probe: boolean;
    readonly nextEligibleAt?: Date;
    readonly state: CircuitRuntimeState;
  }> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = (await this.getCore<CircuitRuntimeState>(
        key.runtime(input.context.tenantId, input.destinationId, "CIRCUIT"),
      )) ?? { state: "CLOSED" as const, consecutiveFailures: 0, version: 0 };
      if (current.state === "CLOSED")
        return { allowed: true, probe: false, state: current };
      const expiration =
        current.probeLeaseExpiresAt === undefined
          ? undefined
          : new Date(current.probeLeaseExpiresAt);
      const nextProbe =
        current.nextProbeAt === undefined
          ? input.now
          : new Date(current.nextProbeAt);
      if (current.state === "OPEN" && nextProbe.getTime() > input.now.getTime())
        return {
          allowed: false,
          probe: false,
          nextEligibleAt: nextProbe,
          state: current,
        };
      if (
        current.state === "HALF_OPEN" &&
        expiration !== undefined &&
        expiration.getTime() > input.now.getTime()
      )
        return {
          allowed: false,
          probe: false,
          nextEligibleAt: expiration,
          state: current,
        };
      const probe: CircuitRuntimeState = {
        ...current,
        state: "HALF_OPEN",
        probeLeaseOwner: input.owner,
        probeLeaseExpiresAt: new Date(
          input.now.getTime() + input.policy.probeLeaseSeconds * 1_000,
        ).toISOString() as never,
        version: current.version + 1,
      };
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.config.coreTableName,
            Item: itemWithKeys(
              probe,
              key.runtime(
                input.context.tenantId,
                input.destinationId,
                "CIRCUIT",
              ),
              "CIRCUIT_RUNTIME",
            ),
            ConditionExpression:
              "attribute_not_exists(PK) OR #version = :version",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": current.version },
          }),
        );
        return { allowed: true, probe: true, state: probe };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    const state: CircuitRuntimeState = {
      state: "OPEN",
      consecutiveFailures: 0,
      nextProbeAt: new Date(input.now.getTime() + 5_000).toISOString() as never,
      version: 0,
    };
    return {
      allowed: false,
      probe: false,
      nextEligibleAt: new Date(input.now.getTime() + 5_000),
      state,
    };
  }
  public circuitAfterAttempt(
    input: Parameters<DeliveryConcurrencyRepository["circuitAfterAttempt"]>[0],
  ): CircuitRuntimeState {
    const version = input.current.version + 1;
    if (input.success)
      return { state: "CLOSED", consecutiveFailures: 0, version };
    if (!input.countsTowardCircuit) return { ...input.current, version };
    const failures = input.current.consecutiveFailures + 1;
    if (input.probe || failures >= input.policy.failureThreshold)
      return {
        state: "OPEN",
        consecutiveFailures: failures,
        openedAt: input.now.toISOString() as never,
        nextProbeAt: new Date(
          input.now.getTime() + input.policy.cooldownSeconds * 1_000,
        ).toISOString() as never,
        version,
      };
    return { state: "CLOSED", consecutiveFailures: failures, version };
  }
  public async recoverExpired(
    input: Parameters<DeliveryConcurrencyRepository["recoverExpired"]>[0],
  ): Promise<boolean> {
    const delivery = await this.getDelivery(input.context, input.deliveryId);
    if (
      delivery === undefined ||
      delivery.state !== "in_progress" ||
      delivery.leaseExpiresAt === undefined ||
      new Date(delivery.leaseExpiresAt).getTime() > input.now.getTime()
    )
      return false;
    const next = transitionDelivery(delivery, {
      to: "scheduled",
      at: input.now.toISOString() as never,
      expectedVersion: delivery.version,
      leaseToken: delivery.leaseToken ?? ("expired-lease" as never),
      nextEligibleAt: input.now.toISOString() as never,
    });
    const history: DeliveryHistoryEntry = {
      historyId: `recovery-${delivery.deliveryId}-${delivery.version}`,
      deliveryId: delivery.deliveryId,
      tenantId: delivery.tenantId,
      correlationId: delivery.correlationId,
      type: "lease_recovered",
      occurredAt: input.now.toISOString() as never,
      summary: "Expired delivery lease recovered.",
      metadata: {},
      expiresAt: delivery.expiresAt,
    };
    const outbox: OutboxRecord = {
      outboxId:
        `obx_recovery_${delivery.deliveryId}_${delivery.version}` as never,
      kind: "SCHEDULE_DELIVERY",
      tenantId: delivery.tenantId,
      aggregateType: "DELIVERY",
      aggregateId: delivery.deliveryId,
      target: "SCHEDULER",
      payload: {
        eventId: delivery.eventId,
        deliveryId: delivery.deliveryId,
        correlationId: delivery.correlationId,
        notBefore: input.now.toISOString(),
        cause: "RESUME",
      },
      createdAt: input.now.toISOString() as never,
      attempts: 0,
      schemaVersion: 1,
    };
    return this.defer({
      context: input.context,
      eventId: delivery.eventId,
      delivery: next,
      expectedVersion: delivery.version,
      leaseToken: delivery.leaseToken ?? "",
      history,
      outbox,
    });
  }
  public async resumeDestination(
    input: Parameters<DeliveryConcurrencyRepository["resumeDestination"]>[0],
  ): Promise<number> {
    const index = await this.client.send(
      new QueryCommand({
        TableName: this.config.coreTableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": `TENANT#${input.context.tenantId}#DELIVERY_INDEX#DESTINATION#${input.destinationId}`,
        },
        Limit: 100,
      }),
    );
    const ids = new Set(
      (index.Items ?? [])
        .filter((entry) => !isExpired(entry))
        .map((entry) => entry.deliveryId)
        .filter((value): value is string => typeof value === "string"),
    );
    let resumed = 0;
    for (const deliveryId of ids) {
      const current = await this.getDelivery(
        input.context,
        deliveryId as never,
      );
      if (
        current === undefined ||
        current.destinationId !== input.destinationId ||
        current.blockedReason !== "DESTINATION_DISABLED" ||
        isTerminalDeliveryState(current.state)
      )
        continue;
      const delivery = transitionDelivery(current, {
        to: "scheduled",
        at: input.now.toISOString() as never,
        expectedVersion: current.version,
        nextEligibleAt: input.now.toISOString() as never,
      });
      const outbox: OutboxRecord = {
        outboxId:
          `obx_resume_${current.deliveryId}_${current.version}` as never,
        kind: "RESUME_DELIVERY",
        tenantId: current.tenantId,
        aggregateType: "DELIVERY",
        aggregateId: current.deliveryId,
        target: "DELIVERY_QUEUE",
        payload: {
          eventId: current.eventId,
          deliveryId: current.deliveryId,
          correlationId: current.correlationId,
          cause: "RESUME",
          notBefore: input.now.toISOString(),
        },
        createdAt: input.now.toISOString() as never,
        attempts: 0,
        schemaVersion: 1,
      };
      const shard = stableShard(outbox.outboxId, this.config.outboxShardCount);
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.config.coreTableName,
                  Item: itemWithKeys(
                    {
                      ...delivery,
                      expiresAt: epochSeconds(delivery.expiresAt),
                    },
                    key.delivery(
                      current.tenantId,
                      current.eventId,
                      current.deliveryId,
                    ),
                    "DELIVERY",
                  ),
                  ConditionExpression: "#version = :version",
                  ExpressionAttributeNames: { "#version": "version" },
                  ExpressionAttributeValues: { ":version": current.version },
                },
              },
              ...deliveryIndexCategories(current).map((category) => ({
                Delete: {
                  TableName: this.config.coreTableName,
                  Key: key.deliveryIndex(
                    current.tenantId,
                    category,
                    current.updatedAt,
                    current.deliveryId,
                  ),
                },
              })),
              ...deliveryIndexCategories(delivery).map((category) => ({
                Put: {
                  TableName: this.config.coreTableName,
                  Item: deliveryIndexItem(delivery, category),
                },
              })),
              {
                Put: {
                  TableName: this.config.coreTableName,
                  Item: itemWithKeys(
                    {
                      ...outbox,
                      expiresAt: epochSeconds(
                        new Date(input.now.getTime() + 7 * 86_400_000),
                      ),
                      GSI1PK: `OUTBOX#UNPUBLISHED#${shard}`,
                      GSI1SK: `${outbox.createdAt}#${outbox.outboxId}`,
                    },
                    key.outbox(shard, outbox.createdAt, outbox.outboxId),
                    "OUTBOX",
                  ),
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
            ] as never,
          }),
        );
        resumed += 1;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    return resumed;
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
