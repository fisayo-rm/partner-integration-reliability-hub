import type {
  AuditEvent,
  CanonicalEvent,
  ClientId,
  CorrelationId,
  DeliveryExecution,
  Destination,
  EventId,
  JsonObject,
  OutboxRecord,
  Partner,
  Subscription,
  TenantContext,
  TransformationVersion,
} from "@pirh/domain";

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
    outboxId: OutboxRecord["outboxId"],
    publishedAt: Date,
  ): Promise<void>;
  recordPublicationFailure(
    outboxId: OutboxRecord["outboxId"],
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
  resolve(
    referenceName: string,
  ): Promise<{ readonly value: string; readonly version?: string }>;
}
export interface IdentityProvider {
  verifyAccessToken(token: string): Promise<{
    readonly issuer: string;
    readonly subject: string;
    readonly tenantId: TenantContext["tenantId"];
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
