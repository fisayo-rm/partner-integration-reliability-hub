import { createHash } from "node:crypto";
import { transitionDelivery } from "@pirh/domain";
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

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

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
/** Control-plane access remains tenant scoped; persistence adapters own key details. */
export interface ControlPlaneRepository {
  listPartners(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<Partner>>;
  listControlSubscriptions(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<Subscription>>;
  listTransformationVersions(
    context: TenantContext,
    transformationId: TransformationVersion["transformationId"],
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<TransformationVersion>>;
  createPartner(
    context: TenantContext,
    partner: Partner,
    audit: AuditEvent,
  ): Promise<"created" | "conflict" | "limit">;
  updatePartner(
    context: TenantContext,
    partner: Partner,
    expectedVersion: number,
    audit: AuditEvent,
  ): Promise<"updated" | "not_found" | "conflict">;
  createDestination(
    context: TenantContext,
    destination: Destination,
    audit: AuditEvent,
  ): Promise<"created" | "conflict" | "limit" | "not_found">;
  updateDestination(
    context: TenantContext,
    destination: Destination,
    expectedVersion: number,
    audit: AuditEvent,
  ): Promise<"updated" | "not_found" | "conflict">;
  createTransformationVersion(
    context: TenantContext,
    transformation: TransformationVersion,
    audit: AuditEvent,
  ): Promise<"created" | "conflict">;
  createSubscription(
    context: TenantContext,
    subscription: Subscription,
    audit: AuditEvent,
  ): Promise<"created" | "conflict" | "not_found">;
  deleteSubscription(
    context: TenantContext,
    subscriptionId: Subscription["subscriptionId"],
    audit: AuditEvent,
  ): Promise<"deleted" | "not_found">;
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
  }): Promise<
    | { readonly kind: "accepted"; readonly event: CanonicalEvent }
    | { readonly kind: "duplicate"; readonly event: CanonicalEvent }
    | { readonly kind: "conflict" }
  >;
}
export interface RoutingRepository {
  createDelivery(input: {
    readonly context: TenantContext;
    readonly delivery: DeliveryExecution;
    readonly history: DeliveryHistoryEntry;
    readonly outbox?: OutboxRecord;
  }): Promise<"created" | "duplicate">;
  completeRouting(context: TenantContext, eventId: EventId): Promise<void>;
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
  }): Promise<DeliveryExecution | undefined>;
  finalizeSuccess(input: {
    readonly context: TenantContext;
    readonly eventId: EventId;
    readonly delivery: DeliveryExecution;
    readonly expectedVersion: number;
    readonly attempt: DeliveryAttempt;
    readonly history: DeliveryHistoryEntry;
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
      | "ptr"
      | "dst"
      | "req"
      | "lease",
  ): string;
}
export interface EndpointValidator {
  validateUrl(url: string): Promise<unknown>;
}
export interface ControlPlaneDependencies {
  readonly repository: ControlPlaneRepository;
  readonly audit: AuditRepository;
  readonly secrets: SecretStore;
  readonly endpoints: EndpointValidator;
  readonly execute: (
    definition: JsonObject,
    sample: JsonObject,
  ) => {
    readonly output: JsonObject;
    readonly serialized: string;
    readonly hash: string;
  };
  readonly ids: IdGenerator;
  readonly clock: Clock;
}
export class ControlPlaneService {
  public constructor(private readonly dependencies: ControlPlaneDependencies) {}
  private audit(
    context: TenantContext,
    action: string,
    targetType: string,
    targetId: string,
    metadata: JsonObject,
  ): AuditEvent {
    const at = this.dependencies.clock.now().toISOString() as never;
    return {
      auditId: this.dependencies.ids.next("aud") as AuditEvent["auditId"],
      tenantId: context.tenantId,
      actorId: context.actorId,
      ...(context.role === undefined ? {} : { actorRole: context.role }),
      action,
      targetType,
      targetId,
      requestId: context.requestId,
      correlationId: context.correlationId,
      metadata,
      occurredAt: at,
      expiresAt: new Date(
        this.dependencies.clock.now().getTime() + 90 * 86_400_000,
      ).toISOString() as never,
    };
  }
  public async createPartner(
    context: TenantContext,
    input: {
      readonly name: string;
      readonly externalKey: string;
      readonly description?: string;
      readonly enabled: boolean;
    },
  ): Promise<Partner> {
    const at = this.dependencies.clock.now().toISOString() as never;
    const partner: Partner = {
      partnerId: this.dependencies.ids.next("ptr") as Partner["partnerId"],
      tenantId: context.tenantId,
      name: input.name,
      externalKey: input.externalKey as Partner["externalKey"],
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      enabled: input.enabled,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    const result = await this.dependencies.repository.createPartner(
      context,
      partner,
      this.audit(context, "partner.created", "PARTNER", partner.partnerId, {
        externalKey: input.externalKey,
      }),
    );
    if (result !== "created")
      throw new Error(result === "limit" ? "PARTNER_LIMIT" : "CONFLICT");
    return partner;
  }
  public async updatePartner(
    context: TenantContext,
    existing: Partner,
    expectedVersion: number,
    input: {
      readonly name?: string;
      readonly description?: string | null;
      readonly enabled?: boolean;
    },
  ): Promise<Partner> {
    const at = this.dependencies.clock.now().toISOString() as never;
    const withoutDescription = { ...existing } as {
      -readonly [Key in keyof Partner]: Partner[Key];
    };
    if (input.description === null) delete withoutDescription.description;
    const partner: Partner = {
      ...withoutDescription,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined || input.description === null
        ? {}
        : { description: input.description }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updatedAt: at,
      version: existing.version + 1,
    };
    const result = await this.dependencies.repository.updatePartner(
      context,
      partner,
      expectedVersion,
      this.audit(context, "partner.updated", "PARTNER", partner.partnerId, {
        version: partner.version,
      }),
    );
    if (result !== "updated")
      throw new Error(
        result === "not_found" ? "NOT_FOUND" : "PRECONDITION_FAILED",
      );
    return partner;
  }
  public async createTransformation(
    context: TenantContext,
    input: {
      readonly externalKey: string;
      readonly definition: JsonObject;
      readonly sampleEvent?: JsonObject;
    },
  ): Promise<TransformationVersion> {
    if (input.sampleEvent !== undefined)
      this.dependencies.execute(input.definition, input.sampleEvent);
    const at = this.dependencies.clock.now().toISOString() as never;
    const transformation: TransformationVersion = {
      transformationId: this.dependencies.ids.next(
        "trf",
      ) as TransformationVersion["transformationId"],
      tenantId: context.tenantId,
      externalKey: input.externalKey as TransformationVersion["externalKey"],
      version: 1,
      definition: input.definition,
      createdAt: at,
      createdBy: context.actorId,
    };
    if (
      (await this.dependencies.repository.createTransformationVersion(
        context,
        transformation,
        this.audit(
          context,
          "transformation.created",
          "TRANSFORMATION",
          transformation.transformationId,
          { externalKey: input.externalKey, version: 1 },
        ),
      )) !== "created"
    )
      throw new Error("CONFLICT");
    return transformation;
  }
  public async createTransformationVersion(
    context: TenantContext,
    existing: TransformationVersion,
    input: {
      readonly definition: JsonObject;
      readonly sampleEvent?: JsonObject;
    },
  ): Promise<TransformationVersion> {
    if (input.sampleEvent !== undefined)
      this.dependencies.execute(input.definition, input.sampleEvent);
    const at = this.dependencies.clock.now().toISOString() as never;
    const transformation: TransformationVersion = {
      ...existing,
      version: existing.version + 1,
      definition: input.definition,
      createdAt: at,
      createdBy: context.actorId,
    };
    if (
      (await this.dependencies.repository.createTransformationVersion(
        context,
        transformation,
        this.audit(
          context,
          "transformation.version_created",
          "TRANSFORMATION",
          transformation.transformationId,
          { version: transformation.version },
        ),
      )) !== "created"
    )
      throw new Error("CONFLICT");
    return transformation;
  }
  public async validateTransformation(input: {
    readonly definition: JsonObject;
    readonly sampleEvent: JsonObject;
  }) {
    return this.dependencies.execute(input.definition, input.sampleEvent);
  }
  private async credential(
    context: TenantContext,
    input: { readonly alias: string; readonly value: string },
  ): Promise<SecretReference> {
    return this.dependencies.secrets.store(context, {
      name: input.alias,
      value: input.value,
    });
  }
  public async createDestination(
    context: TenantContext,
    input: Omit<
      Destination,
      "destinationId" | "tenantId" | "secretReferences" | "version"
    > & {
      readonly credential: { readonly alias: string; readonly value: string };
    },
  ): Promise<Destination> {
    await this.dependencies.endpoints.validateUrl(
      new URL(input.path, input.baseUrl).toString(),
    );
    await this.dependencies.audit.append(
      this.audit(
        context,
        "destination.credential_rotation_requested",
        "DESTINATION",
        "pending",
        { alias: input.credential.alias },
      ),
    );
    const { credential, ...configuration } = input;
    const secret = await this.credential(context, credential);
    const destination: Destination = {
      ...configuration,
      destinationId: this.dependencies.ids.next(
        "dst",
      ) as Destination["destinationId"],
      tenantId: context.tenantId,
      secretReferences: [{ name: secret.name }],
      version: 1,
    };
    const result = await this.dependencies.repository.createDestination(
      context,
      destination,
      this.audit(
        context,
        "destination.created",
        "DESTINATION",
        destination.destinationId,
        { externalKey: destination.externalKey, credentialAlias: secret.name },
      ),
    );
    if (result !== "created")
      throw new Error(
        result === "not_found"
          ? "NOT_FOUND"
          : result === "limit"
            ? "DESTINATION_LIMIT"
            : "CONFLICT",
      );
    return destination;
  }
  public async updateDestination(
    context: TenantContext,
    existing: Destination,
    expectedVersion: number,
    input: Partial<Destination> & {
      readonly credential?: { readonly alias: string; readonly value: string };
    },
  ): Promise<Destination> {
    if (input.baseUrl !== undefined || input.path !== undefined)
      await this.dependencies.endpoints.validateUrl(
        new URL(
          input.path ?? existing.path,
          input.baseUrl ?? existing.baseUrl,
        ).toString(),
      );
    let secretReferences = existing.secretReferences;
    if (input.credential !== undefined) {
      await this.dependencies.audit.append(
        this.audit(
          context,
          "destination.credential_rotation_requested",
          "DESTINATION",
          existing.destinationId,
          { alias: input.credential.alias },
        ),
      );
      const secret = await this.credential(context, input.credential);
      secretReferences = [{ name: secret.name }];
    }
    const changes = { ...input } as Record<string, unknown>;
    delete changes.credential;
    delete changes.authentication;
    const destination: Destination = {
      ...existing,
      ...changes,
      secretReferences,
      version: existing.version + 1,
    };
    const result = await this.dependencies.repository.updateDestination(
      context,
      destination,
      expectedVersion,
      this.audit(
        context,
        input.enabled === false
          ? "destination.disabled"
          : "destination.updated",
        "DESTINATION",
        destination.destinationId,
        { version: destination.version },
      ),
    );
    if (result !== "updated")
      throw new Error(
        result === "not_found" ? "NOT_FOUND" : "PRECONDITION_FAILED",
      );
    return destination;
  }
  public async createSubscription(
    context: TenantContext,
    input: {
      readonly externalKey: string;
      readonly destinationId: Subscription["destinationId"];
      readonly eventType: string;
      readonly enabled: boolean;
    },
  ): Promise<Subscription> {
    const at = this.dependencies.clock.now().toISOString() as never;
    const subscription: Subscription = {
      subscriptionId: this.dependencies.ids.next(
        "sub",
      ) as Subscription["subscriptionId"],
      externalKey: input.externalKey as Subscription["externalKey"],
      tenantId: context.tenantId,
      destinationId: input.destinationId,
      eventType: input.eventType,
      enabled: input.enabled,
      createdAt: at,
    };
    if (
      (await this.dependencies.repository.createSubscription(
        context,
        subscription,
        this.audit(
          context,
          "subscription.created",
          "SUBSCRIPTION",
          subscription.subscriptionId,
          { eventType: input.eventType },
        ),
      )) !== "created"
    )
      throw new Error("CONFLICT");
    return subscription;
  }
  public async deleteSubscription(
    context: TenantContext,
    subscriptionId: Subscription["subscriptionId"],
  ): Promise<void> {
    if (
      (await this.dependencies.repository.deleteSubscription(
        context,
        subscriptionId,
        this.audit(
          context,
          "subscription.deleted",
          "SUBSCRIPTION",
          subscriptionId,
          {},
        ),
      )) !== "deleted"
    )
      throw new Error("NOT_FOUND");
  }
  private execute(definition: JsonObject, sample: JsonObject) {
    return this.dependencies.execute(definition, sample);
  }
}
export interface RequestIdentity {
  readonly tenantId: TenantContext["tenantId"];
  readonly clientId: ClientId;
  readonly correlationId: CorrelationId;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalJsonHash(value: JsonObject): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function deterministicIdentifier(
  prefix: "dlv" | "obx",
  value: string,
): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = createHash("sha256").update(value).digest();
  let bits = 0;
  let buffer = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && encoded.length < 26) {
      bits -= 5;
      encoded += alphabet[(buffer >> bits) & 31];
    }
    if (encoded.length === 26) break;
  }
  return `${prefix}_${encoded.padEnd(26, "0")}`;
}

export interface EventIngestionDependencies {
  readonly writer: EventAcceptanceWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly supportedEventTypes: ReadonlySet<string>;
  readonly eventRetentionDays: number;
}

export class EventIngestionService {
  public constructor(
    private readonly dependencies: EventIngestionDependencies,
  ) {}
  public async accept(
    context: TenantContext,
    input: {
      readonly eventType: string;
      readonly occurredAt: string;
      readonly subject: CanonicalEvent["subject"];
      readonly data: JsonObject;
      readonly metadata: JsonObject;
      readonly idempotencyKey: string;
    },
  ) {
    if (!this.dependencies.supportedEventTypes.has(input.eventType))
      throw new Error("UNSUPPORTED_EVENT_TYPE");
    const now = this.dependencies.clock.now();
    const at = now.toISOString() as CanonicalEvent["acceptedAt"];
    const eventId = this.dependencies.ids.next("evt") as EventId;
    const correlationId = this.dependencies.ids.next("cor") as CorrelationId;
    const canonical: JsonObject = {
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      subject: input.subject as never,
      data: input.data,
      metadata: input.metadata,
    };
    const event: CanonicalEvent = {
      eventId,
      tenantId: context.tenantId,
      producerClientId: context.actorId as ClientId,
      correlationId,
      eventType: input.eventType,
      occurredAt: input.occurredAt as CanonicalEvent["occurredAt"],
      acceptedAt: at,
      subject: input.subject,
      data: input.data,
      metadata: input.metadata,
      payloadHash: canonicalJsonHash(canonical),
      status: "accepted",
      outcome: {
        routingComplete: false,
        totalDeliveries: 0,
        terminalDeliveries: 0,
        successfulDeliveries: 0,
        failedTerminalDeliveries: 0,
        deadLetteredDeliveries: 0,
      },
      version: 1,
      expiresAt: new Date(
        now.getTime() + this.dependencies.eventRetentionDays * 86_400_000,
      ).toISOString() as CanonicalEvent["expiresAt"],
    };
    const outbox: OutboxRecord = {
      outboxId: this.dependencies.ids.next("obx") as OutboxRecord["outboxId"],
      kind: "ROUTE_EVENT",
      tenantId: context.tenantId,
      aggregateType: "EVENT",
      aggregateId: eventId,
      target: "ROUTING_QUEUE",
      payload: { eventId, correlationId, cause: "INITIAL" },
      createdAt: at,
      attempts: 0,
      schemaVersion: 1,
    };
    const result = await this.dependencies.writer.accept({
      context: { ...context, correlationId },
      event,
      requestBodyHash: canonicalJsonHash(canonical),
      idempotencyKeyHash: createHash("sha256")
        .update(input.idempotencyKey)
        .digest("hex"),
      responseStatus: 202,
      outbox,
    });
    if (result.kind === "conflict") throw new Error("IDEMPOTENCY_KEY_REUSED");
    return {
      event: result.event,
      previouslyAccepted: result.kind === "duplicate",
    };
  }
}

export interface RoutingDependencies {
  readonly core: CoreRepository;
  readonly repository: RoutingRepository;
  readonly execute: ControlPlaneDependencies["execute"];
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly retentionDays: number;
}

function routingContext(
  tenantId: TenantContext["tenantId"],
  correlationId: CorrelationId,
): TenantContext {
  return {
    tenantId,
    actorType: "system",
    actorId: "router-worker",
    requestId: "router-worker",
    correlationId,
  };
}

export class RoutingService {
  public constructor(private readonly dependencies: RoutingDependencies) {}
  public async route(input: {
    readonly tenantId: TenantContext["tenantId"];
    readonly eventId: EventId;
    readonly correlationId: CorrelationId;
  }): Promise<void> {
    const context = routingContext(input.tenantId, input.correlationId);
    const event = await this.dependencies.core.getEvent(context, input.eventId);
    if (event === undefined) return;
    const subscriptions = (
      await this.dependencies.core.listSubscriptions(context, event.eventType)
    ).filter((subscription) => subscription.enabled);
    let created = 0;
    for (const subscription of subscriptions) {
      const destination = await this.dependencies.core.getDestination(
        context,
        subscription.destinationId,
      );
      if (destination === undefined || !destination.enabled) continue;
      const partner = await this.dependencies.core.getPartner(
        context,
        destination.partnerId,
      );
      if (partner === undefined || !partner.enabled) continue;
      const transformation =
        await this.dependencies.core.getTransformationVersion(
          context,
          destination.transformationId,
          destination.activeTransformationVersion,
        );
      if (transformation === undefined) continue;
      const deliveryId = deterministicIdentifier(
        "dlv",
        `${event.tenantId}\n${event.eventId}\n${destination.destinationId}\nORIGINAL`,
      ) as DeliveryExecution["deliveryId"];
      const at = this.dependencies.clock
        .now()
        .toISOString() as DeliveryExecution["createdAt"];
      const url = new URL(destination.path, destination.baseUrl).toString();
      const snapshot = {
        destinationVersion: destination.version,
        url,
        method: destination.method,
        timeoutMs: destination.timeoutMs,
        retryPolicy: destination.retryPolicy,
        rateLimitPolicyId: `${destination.destinationId}:v${destination.version}`,
        circuitBreakerPolicyId: `${destination.destinationId}:v${destination.version}`,
        authType: destination.authType,
        authConfiguration: destination.authConfiguration,
        secretReferenceNames: destination.secretReferences.map(
          (reference) => reference.name,
        ),
        transformationId: transformation.transformationId,
        transformationVersion: transformation.version,
        redactionPaths: destination.sensitiveResponseJsonPaths,
        ...(typeof destination.authConfiguration.idempotencyHeader === "string"
          ? {
              idempotencyHeader:
                destination.authConfiguration.idempotencyHeader,
            }
          : {}),
      } as DeliveryExecution["configSnapshot"];
      try {
        const transformed = this.dependencies.execute(
          transformation.definition,
          event as unknown as JsonObject,
        );
        const delivery: DeliveryExecution = {
          deliveryId,
          eventId: event.eventId,
          correlationId: event.correlationId,
          tenantId: event.tenantId,
          partnerId: destination.partnerId,
          destinationId: destination.destinationId,
          executionType: "ORIGINAL",
          state: "scheduled",
          attemptCount: 0,
          maxAttempts: destination.retryPolicy.maxAttempts,
          nextEligibleAt: at,
          configSnapshot: snapshot,
          transformedPayload: transformed.output,
          transformedPayloadHash: transformed.hash,
          partnerIdempotencyKey: createHash("sha256")
            .update(
              `${event.tenantId}\n${event.eventId}\n${destination.destinationId}\n${deliveryId}`,
            )
            .digest("base64url"),
          createdAt: at,
          updatedAt: at,
          version: 1,
          expiresAt: new Date(
            this.dependencies.clock.now().getTime() +
              this.dependencies.retentionDays * 86_400_000,
          ).toISOString() as DeliveryExecution["expiresAt"],
        };
        const history: DeliveryHistoryEntry = {
          historyId: this.dependencies.ids.next("req"),
          deliveryId,
          tenantId: event.tenantId,
          correlationId: event.correlationId,
          type: "created",
          occurredAt: at,
          summary: "Delivery created and scheduled.",
          metadata: {},
        };
        const outbox: OutboxRecord = {
          outboxId: deterministicIdentifier(
            "obx",
            `DELIVER\n${deliveryId}`,
          ) as OutboxRecord["outboxId"],
          kind: "DELIVER",
          tenantId: event.tenantId,
          aggregateType: "DELIVERY",
          aggregateId: deliveryId,
          target: "DELIVERY_QUEUE",
          payload: {
            eventId: event.eventId,
            deliveryId,
            correlationId: event.correlationId,
            cause: "INITIAL",
          },
          createdAt: at,
          attempts: 0,
          schemaVersion: 1,
        };
        const result = await this.dependencies.repository.createDelivery({
          context,
          delivery,
          history,
          outbox,
        });
        if (result === "created") created += 1;
      } catch {
        const delivery: DeliveryExecution = {
          deliveryId,
          eventId: event.eventId,
          correlationId: event.correlationId,
          tenantId: event.tenantId,
          partnerId: destination.partnerId,
          destinationId: destination.destinationId,
          executionType: "ORIGINAL",
          state: "failed_terminal",
          blockedReason: "TRANSFORMATION_ERROR",
          attemptCount: 0,
          maxAttempts: destination.retryPolicy.maxAttempts,
          configSnapshot: snapshot,
          transformedPayload: {},
          transformedPayloadHash: createHash("sha256")
            .update("{}")
            .digest("hex"),
          partnerIdempotencyKey: createHash("sha256")
            .update(
              `${event.tenantId}\n${event.eventId}\n${destination.destinationId}\n${deliveryId}`,
            )
            .digest("base64url"),
          createdAt: at,
          updatedAt: at,
          terminalAt: at,
          version: 1,
          expiresAt: new Date(
            this.dependencies.clock.now().getTime() +
              this.dependencies.retentionDays * 86_400_000,
          ).toISOString() as DeliveryExecution["expiresAt"],
        };
        await this.dependencies.repository.createDelivery({
          context,
          delivery,
          history: {
            historyId: this.dependencies.ids.next("req"),
            deliveryId,
            tenantId: event.tenantId,
            correlationId: event.correlationId,
            type: "state_transition",
            occurredAt: at,
            summary: "Transformation failed.",
            metadata: { failureCategory: "TRANSFORMATION_ERROR" },
          },
        });
      }
    }
    void created;
    await this.dependencies.repository.completeRouting(context, event.eventId);
  }
}

export interface OAuthTokenProvider {
  get(input: {
    readonly destinationId: string;
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly scopes: readonly string[];
    readonly authenticationStyle: "basic" | "body";
    readonly correlationId: CorrelationId;
  }): Promise<string>;
}
export interface DeliveryDependencies {
  readonly core: CoreRepository;
  readonly repository: DeliveryConcurrencyRepository;
  readonly secrets: SecretStore;
  readonly http: PartnerHttpClient;
  readonly oauth: OAuthTokenProvider;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

function redactedHeaders(headers: Readonly<Record<string, string>>) {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    result[name] = /authorization|api-key/i.test(name) ? "[REDACTED]" : value;
  return result;
}
function responseEvidence(
  headers: Readonly<Record<string, string>>,
  body: string,
  redactionPaths: readonly string[],
) {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (
      [
        "content-type",
        "content-length",
        "retry-after",
        "x-request-id",
      ].includes(name.toLowerCase())
    )
      safe[name.toLowerCase()] = value;
  let excerpt = body.slice(0, 16 * 1024);
  try {
    const parsed = JSON.parse(excerpt) as Record<string, unknown>;
    for (const path of redactionPaths) {
      const parts = path.replace(/^\$\./, "").split(".");
      let target: Record<string, unknown> | undefined = parsed;
      for (const part of parts.slice(0, -1))
        target =
          target !== undefined &&
          typeof target[part] === "object" &&
          target[part] !== null
            ? (target[part] as Record<string, unknown>)
            : undefined;
      const final = parts.at(-1);
      if (target !== undefined && final !== undefined && final in target)
        target[final] = "[REDACTED]";
    }
    excerpt = JSON.stringify(parsed);
  } catch {
    // Opaque bodies are retained only as a bounded excerpt.
  }
  return {
    headers: safe,
    bodyExcerpt: excerpt,
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
}

export class DeliveryService {
  public constructor(private readonly dependencies: DeliveryDependencies) {}
  public async deliver(input: {
    readonly tenantId: TenantContext["tenantId"];
    readonly eventId: EventId;
    readonly deliveryId: DeliveryExecution["deliveryId"];
    readonly correlationId: CorrelationId;
    readonly owner: string;
  }): Promise<void> {
    const context = routingContext(input.tenantId, input.correlationId);
    const initial = await this.dependencies.core.getDelivery(
      context,
      input.deliveryId,
    );
    if (
      initial === undefined ||
      ["succeeded", "failed_terminal", "dead_lettered", "cancelled"].includes(
        initial.state,
      )
    )
      return;
    const now = this.dependencies.clock.now();
    const token = this.dependencies.ids.next("lease");
    const leased = await this.dependencies.repository.acquireLease({
      context,
      eventId: input.eventId,
      deliveryId: input.deliveryId,
      expectedVersion: initial.version,
      owner: input.owner,
      token,
      expiresAt: new Date(
        now.getTime() + initial.configSnapshot.timeoutMs + 5_000,
      ).toISOString(),
    });
    if (leased === undefined || leased.leaseToken !== token) return;
    const secretName = leased.configSnapshot.secretReferenceNames[0];
    if (secretName === undefined) throw new Error("SECRET_NOT_FOUND");
    const secret = await this.dependencies.secrets.resolve(context, {
      name: secretName,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (leased.configSnapshot.authType === "api_key") {
      const headerName = leased.configSnapshot.authConfiguration.headerName;
      if (typeof headerName !== "string")
        throw new Error("INVALID_AUTH_CONFIGURATION");
      headers[headerName] = secret.value;
      if (leased.configSnapshot.idempotencyHeader !== undefined)
        headers[leased.configSnapshot.idempotencyHeader] =
          leased.partnerIdempotencyKey;
    } else {
      const configuration = leased.configSnapshot.authConfiguration;
      if (
        typeof configuration.tokenUrl !== "string" ||
        typeof configuration.clientId !== "string" ||
        (configuration.authenticationStyle !== "basic" &&
          configuration.authenticationStyle !== "body") ||
        !Array.isArray(configuration.scopes)
      )
        throw new Error("INVALID_AUTH_CONFIGURATION");
      headers.authorization = `Bearer ${await this.dependencies.oauth.get({
        destinationId: leased.destinationId,
        tokenUrl: configuration.tokenUrl,
        clientId: configuration.clientId,
        clientSecret: secret.value,
        scopes: configuration.scopes.filter(
          (scope): scope is string => typeof scope === "string",
        ),
        authenticationStyle: configuration.authenticationStyle,
        correlationId: leased.correlationId,
      })}`;
      headers["x-delivery-key"] = leased.partnerIdempotencyKey;
    }
    const started = this.dependencies.clock.now();
    const body = JSON.stringify(leased.transformedPayload);
    const response = await this.dependencies.http.send({
      url: leased.configSnapshot.url,
      method: leased.configSnapshot.method,
      headers,
      body,
      timeoutMs: leased.configSnapshot.timeoutMs,
      correlationId: leased.correlationId,
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(`PARTNER_HTTP_${response.status}`);
    const completed = this.dependencies.clock.now();
    const evidence = responseEvidence(
      response.headers,
      response.body,
      leased.configSnapshot.redactionPaths,
    );
    const succeeded = {
      ...transitionDelivery(leased, {
        to: "succeeded",
        at: completed.toISOString() as never,
        expectedVersion: leased.version,
        leaseToken: leased.leaseToken,
      }),
      attemptCount: leased.attemptCount + 1,
    };
    const attempt: DeliveryAttempt = {
      attemptId: this.dependencies.ids.next(
        "att",
      ) as DeliveryAttempt["attemptId"],
      attemptNumber: succeeded.attemptCount,
      deliveryId: leased.deliveryId,
      correlationId: leased.correlationId,
      startedAt: started.toISOString() as never,
      completedAt: completed.toISOString() as never,
      durationMs: completed.getTime() - started.getTime(),
      requestMethod: leased.configSnapshot.method,
      requestUrl: leased.configSnapshot.url,
      requestHeadersRedacted: redactedHeaders(headers),
      requestBodyHash: createHash("sha256").update(body).digest("hex"),
      responseStatus: response.status,
      responseHeadersRedacted: evidence.headers,
      responseBodyExcerptRedacted: evidence.bodyExcerpt,
      responseBodyHash: evidence.bodyHash,
      outcome: "succeeded",
    };
    const history: DeliveryHistoryEntry = {
      historyId: this.dependencies.ids.next("req"),
      deliveryId: leased.deliveryId,
      tenantId: leased.tenantId,
      correlationId: leased.correlationId,
      type: "state_transition",
      occurredAt: completed.toISOString() as never,
      summary: "Delivery succeeded.",
      metadata: { state: "succeeded" },
    };
    const finalized = await this.dependencies.repository.finalizeSuccess({
      context,
      eventId: leased.eventId,
      delivery: succeeded,
      expectedVersion: leased.version,
      attempt,
      history,
    });
    if (!finalized) throw new Error("DELIVERY_FINALIZATION_CONFLICT");
  }
}
