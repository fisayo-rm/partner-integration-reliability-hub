import type {
  ApiClient,
  AuditEvent,
  CanonicalEvent,
  ClientId,
  CorrelationId,
  DeliveryExecution,
  Destination,
  DeliveryAttempt,
  DeliveryHistoryEntry,
  EventId,
  JsonObject,
  OutboxRecord,
  Partner,
  Subscription,
  TenantContext,
  Tenant,
  TransformationVersion,
  UserIdentityMapping,
  SecretReference,
} from "@pirh/domain";

export interface IdentityRepository {
  findVerifiedIdentity(
    issuer: string,
    subject: string,
  ): Promise<UserIdentityMapping | undefined>;
}
/** This is intentionally separate from tenant-facing repository APIs. */
export interface ApiClientRepository {
  locateClient(
    clientId: ClientId,
  ): Promise<{ readonly tenantId: TenantContext["tenantId"] } | undefined>;
  getClient(
    context: TenantContext,
    clientId: ClientId,
  ): Promise<ApiClient | undefined>;
}
export interface TenantRepository {
  getTenant(context: TenantContext): Promise<Tenant | undefined>;
}

export interface CoreRepository {
  getEvent(
    context: TenantContext,
    eventId: EventId,
  ): Promise<CanonicalEvent | undefined>;
  getDelivery(
    context: TenantContext,
    deliveryId: DeliveryExecution["deliveryId"],
  ): Promise<DeliveryExecution | undefined>;
  getDestination(
    context: TenantContext,
    destinationId: Destination["destinationId"],
  ): Promise<Destination | undefined>;
  getPartner(
    context: TenantContext,
    partnerId: Partner["partnerId"],
  ): Promise<Partner | undefined>;
  listSubscriptions(
    context: TenantContext,
    eventType: string,
  ): Promise<readonly Subscription[]>;
  getTransformationVersion(
    context: TenantContext,
    transformationId: TransformationVersion["transformationId"],
    version: number,
  ): Promise<TransformationVersion | undefined>;
}
export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  list(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly items: readonly AuditEvent[];
    readonly cursor?: string;
  }>;
}
export interface OutboxRepository {
  getUnpublished(
    shard: number,
    olderThan: Date,
    limit: number,
  ): Promise<readonly OutboxRecord[]>;
  markPublished(
    outbox: Pick<OutboxRecord, "outboxId" | "createdAt">,
    publishedAt: Date,
  ): Promise<void>;
  recordPublicationFailure(
    outbox: Pick<OutboxRecord, "outboxId" | "createdAt">,
    occurredAt: Date,
  ): Promise<void>;
}
export interface AtomicWriteSet {
  readonly core: readonly {
    readonly kind: "put" | "update" | "delete";
    readonly entity: string;
    readonly value: JsonObject;
  }[];
  readonly audit: readonly AuditEvent[];
  readonly outbox: readonly OutboxRecord[];
}
export interface AtomicWriter {
  commit(context: TenantContext, writeSet: AtomicWriteSet): Promise<void>;
}
export interface EventAcceptanceWriter {
  accept(input: {
    readonly context: TenantContext;
    readonly event: CanonicalEvent;
    readonly requestBodyHash: string;
    readonly idempotencyKeyHash: string;
    readonly responseStatus: number;
    readonly outbox: OutboxRecord;
  }): Promise<"accepted" | "duplicate" | "conflict">;
}
export interface DeliveryConcurrencyRepository {
  replaceIfVersion(
    context: TenantContext,
    delivery: DeliveryExecution,
    expectedVersion: number,
  ): Promise<boolean>;
  appendAttemptAndHistory(
    context: TenantContext,
    eventId: EventId,
    attempt: DeliveryAttempt,
    history: DeliveryHistoryEntry,
  ): Promise<void>;
  acquireLease(input: {
    readonly context: TenantContext;
    readonly eventId: EventId;
    readonly deliveryId: DeliveryExecution["deliveryId"];
    readonly expectedVersion: number;
    readonly owner: string;
    readonly token: string;
    readonly expiresAt: string;
  }): Promise<boolean>;
}
export interface NonceRepository {
  putIfAbsent(input: {
    readonly tenantId: TenantContext["tenantId"];
    readonly clientId: ClientId;
    readonly nonceHash: string;
    readonly expiresAt: Date;
  }): Promise<boolean>;
}
export interface QueuePublisher {
  publish(message: {
    readonly body: JsonObject;
    readonly delaySeconds?: number;
    readonly traceparent?: string;
  }): Promise<void>;
}
export interface DeliveryScheduler {
  schedule(input: {
    readonly deliveryId: DeliveryExecution["deliveryId"];
    readonly notBefore: Date;
    readonly cause: string;
  }): Promise<void>;
}
export interface SecretStore {
  store(
    context: TenantContext,
    input: {
      readonly name: string;
      readonly value: string;
      readonly version?: string;
    },
  ): Promise<SecretReference>;
  resolve(
    context: TenantContext,
    reference: SecretReference,
  ): Promise<{ readonly value: string; readonly version?: string }>;
}
export interface IdentityProvider {
  verifyAccessToken(token: string): Promise<{
    readonly issuer: string;
    readonly subject: string;
    readonly roles: readonly string[];
  }>;
}
export interface PartnerHttpClient {
  send(request: {
    readonly url: string;
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly timeoutMs: number;
    readonly correlationId: CorrelationId;
  }): Promise<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }>;
}
export interface Telemetry {
  record(
    name: string,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): void;
}
export interface Clock {
  now(): Date;
}
export interface RandomSource {
  next(): number;
}
export interface IdGenerator {
  next(
    prefix:
      | "evt"
      | "cor"
      | "dlv"
      | "att"
      | "obx"
      | "aud"
      | "rpl"
      | "trf"
      | "sub"
      | "req",
  ): string;
}
export interface RequestIdentity {
  readonly tenantId: TenantContext["tenantId"];
  readonly clientId: ClientId;
  readonly correlationId: CorrelationId;
}
