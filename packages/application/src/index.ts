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
      | "ptr"
      | "dst"
      | "req",
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
