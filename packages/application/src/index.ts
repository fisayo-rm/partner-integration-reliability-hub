import { createHash } from "node:crypto";
import { redactJson as redactJsonValue } from "@pirh/redaction";
import {
  classifyDeliveryResult,
  isTerminalDeliveryState,
  parseRetryAfter,
  replayEligibility,
  retryDelaySeconds,
  transitionDelivery,
} from "@pirh/domain";
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
  FailureCategory,
  CircuitRuntimeState,
  CircuitBreakerPolicy,
  RateLimitPolicy,
  EventId,
  JsonObject,
  OutboxRecord,
  Partner,
  ReplayId,
  ReplayRelation,
  OperationalRollup,
  Subscription,
  TenantContext,
  Tenant,
  TransformationVersion,
  UserIdentityMapping,
  SecretReference,
} from "@pirh/domain";

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string | undefined;
}

export interface TransformationSummary {
  readonly transformationId: TransformationVersion["transformationId"];
  readonly externalKey: string;
  readonly latestVersion: number;
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
  getPartnerByExternalKey(
    context: TenantContext,
    externalKey: string,
  ): Promise<Partner | undefined>;
  getDestinationByExternalKey(
    context: TenantContext,
    externalKey: string,
  ): Promise<Destination | undefined>;
  getSubscriptionByExternalKey(
    context: TenantContext,
    externalKey: string,
  ): Promise<Subscription | undefined>;
  getTransformationByExternalKey(
    context: TenantContext,
    externalKey: string,
  ): Promise<TransformationSummary | undefined>;
  listPartners(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<Partner>>;
  listControlSubscriptions(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<Subscription>>;
  listDestinations(
    context: TenantContext,
    input: {
      readonly limit: number;
      readonly cursor?: string;
      readonly partnerId?: Partner["partnerId"];
    },
  ): Promise<Page<Destination>>;
  getCircuitState(
    context: TenantContext,
    destinationId: Destination["destinationId"],
  ): Promise<CircuitRuntimeState>;
  listTransformations(
    context: TenantContext,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<Page<TransformationSummary>>;
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
    outbox?: OutboxRecord,
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
  updateSubscription(
    context: TenantContext,
    subscription: Subscription,
    expectedVersion: number,
    audit: AuditEvent,
  ): Promise<"updated" | "not_found" | "conflict">;
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
export interface EventDetail {
  readonly event: CanonicalEvent;
  readonly deliveries: readonly DeliveryExecution[];
  readonly replayRelations: readonly ReplayRelation[];
}
export interface DeliveryDetail {
  readonly delivery: DeliveryExecution;
  readonly attempts: readonly DeliveryAttempt[];
  readonly history: readonly DeliveryHistoryEntry[];
  readonly replayRelations: readonly ReplayRelation[];
}
export interface OperationalSearchInput {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly from: string;
  readonly to: string;
  readonly eventId?: EventId | undefined;
  readonly deliveryId?: DeliveryExecution["deliveryId"] | undefined;
  readonly correlationId?: CorrelationId | undefined;
  readonly idempotencyKeyHash?: string | undefined;
  readonly eventType?: string | undefined;
  readonly status?: string | undefined;
  readonly partnerId?: string | undefined;
  readonly destinationId?: string | undefined;
  readonly terminalFailure?: boolean | undefined;
}
export interface OperationsRepository {
  searchEvents(
    context: TenantContext,
    input: OperationalSearchInput,
  ): Promise<Page<CanonicalEvent>>;
  searchDeliveries(
    context: TenantContext,
    input: OperationalSearchInput,
  ): Promise<Page<DeliveryExecution>>;
  getEventDetail(
    context: TenantContext,
    eventId: EventId,
  ): Promise<EventDetail | undefined>;
  getDeliveryDetail(
    context: TenantContext,
    deliveryId: DeliveryExecution["deliveryId"],
  ): Promise<DeliveryDetail | undefined>;
  listAudit(
    context: TenantContext,
    input: OperationalSearchInput,
  ): Promise<Page<AuditEvent>>;
  getRollups(
    context: TenantContext,
    input: { readonly from: string; readonly to: string },
  ): Promise<readonly OperationalRollup[]>;
  listDestinations(
    context: TenantContext,
    input: {
      readonly limit: number;
      readonly cursor?: string;
      readonly partnerId?: Partner["partnerId"];
    },
  ): Promise<Page<Destination>>;
  countDeliveriesByState(
    context: TenantContext,
    state: DeliveryExecution["state"],
  ): Promise<number>;
  getCircuitState(
    context: TenantContext,
    destinationId: Destination["destinationId"],
  ): Promise<CircuitRuntimeState>;
  createReplay(input: {
    readonly context: TenantContext;
    readonly requestHash: string;
    readonly idempotencyKeyHash: string;
    readonly relation: ReplayRelation;
    readonly delivery: DeliveryExecution;
    readonly history: DeliveryHistoryEntry;
    readonly outbox: OutboxRecord;
    readonly audit: AuditEvent;
  }): Promise<
    | {
        readonly kind: "created";
        readonly delivery: DeliveryExecution;
        readonly replayId: ReplayId;
      }
    | {
        readonly kind: "duplicate";
        readonly delivery: DeliveryExecution;
        readonly replayId: ReplayId;
      }
    | { readonly kind: "conflict" }
  >;
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
  startAttempt(input: {
    readonly context: TenantContext;
    readonly eventId: EventId;
    readonly delivery: DeliveryExecution;
    readonly expectedVersion: number;
    readonly attempt: DeliveryAttempt;
  }): Promise<DeliveryExecution | undefined>;
  finalizeAttempt(input: {
    readonly context: TenantContext;
    readonly eventId: EventId;
    readonly delivery: DeliveryExecution;
    readonly expectedVersion: number;
    readonly leaseToken: string;
    readonly attempt: DeliveryAttempt;
    readonly history: DeliveryHistoryEntry;
    readonly outbox?: OutboxRecord;
    readonly circuit?: CircuitRuntimeState;
  }): Promise<boolean>;
  defer(input: {
    readonly context: TenantContext;
    readonly eventId: EventId;
    readonly delivery: DeliveryExecution;
    readonly expectedVersion: number;
    readonly leaseToken: string;
    readonly history: DeliveryHistoryEntry;
    readonly outbox: OutboxRecord;
  }): Promise<boolean>;
  recoverExpired(input: {
    readonly context: TenantContext;
    readonly eventId: EventId;
    readonly deliveryId: DeliveryExecution["deliveryId"];
    readonly now: Date;
    /** Recovery must use injected entropy so its retry schedule is testable. */
    readonly random: number;
  }): Promise<boolean>;
  acquireRatePermit(input: {
    readonly context: TenantContext;
    readonly destinationId: Destination["destinationId"];
    readonly policy: RateLimitPolicy;
    readonly now: Date;
  }): Promise<{ readonly permitted: boolean; readonly nextEligibleAt: Date }>;
  acquireCircuitPermit(input: {
    readonly context: TenantContext;
    readonly destinationId: Destination["destinationId"];
    readonly policy: CircuitBreakerPolicy;
    readonly owner: string;
    readonly now: Date;
  }): Promise<{
    readonly allowed: boolean;
    readonly probe: boolean;
    readonly nextEligibleAt?: Date;
    readonly state: CircuitRuntimeState;
  }>;
  circuitAfterAttempt(input: {
    readonly current: CircuitRuntimeState;
    readonly policy: CircuitBreakerPolicy;
    readonly now: Date;
    readonly success: boolean;
    readonly countsTowardCircuit: boolean;
    readonly probe: boolean;
  }): CircuitRuntimeState;
  resumeDestination(input: {
    readonly context: TenantContext;
    readonly destinationId: Destination["destinationId"];
    readonly now: Date;
  }): Promise<number>;
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
  /** Checks a logical alias without materializing a secret value. */
  isBound(context: TenantContext, alias: string): Promise<boolean>;
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
  count(
    name: string,
    value?: number,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): void;
  duration(
    name: string,
    valueMs: number,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): void;
  gauge(
    name: string,
    value: number,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): void;
  traceparent(): string | undefined;
  traceId(): string | undefined;
}
export const noopTelemetry: Telemetry = {
  count: () => undefined,
  duration: () => undefined,
  gauge: () => undefined,
  traceparent: () => undefined,
  traceId: () => undefined,
};
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
  /**
   * Import-only counterpart to createDestination. The alias was validated by
   * the portability service and is deliberately never resolved here.
   */
  public async createDestinationFromAlias(
    context: TenantContext,
    input: Omit<
      Destination,
      "destinationId" | "tenantId" | "secretReferences" | "version"
    > & { readonly secretAlias: string },
  ): Promise<Destination> {
    await this.dependencies.endpoints.validateUrl(
      new URL(input.path, input.baseUrl).toString(),
    );
    const { secretAlias, ...configuration } = input;
    const at = this.dependencies.clock.now().toISOString() as never;
    const destination: Destination = {
      ...configuration,
      destinationId: this.dependencies.ids.next(
        "dst",
      ) as Destination["destinationId"],
      tenantId: context.tenantId,
      secretReferences: [{ name: secretAlias }],
      version: 1,
    };
    const result = await this.dependencies.repository.createDestination(
      context,
      destination,
      this.audit(
        context,
        "destination.imported",
        "DESTINATION",
        destination.destinationId,
        {
          externalKey: destination.externalKey,
          importedAt: at,
        },
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
      readonly credentialAlias?: string;
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
    if (input.credentialAlias !== undefined)
      secretReferences = [{ name: input.credentialAlias }];
    const changes = { ...input } as Record<string, unknown>;
    delete changes.credential;
    delete changes.credentialAlias;
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
      existing.enabled === false && destination.enabled === true
        ? {
            outboxId: this.dependencies.ids.next(
              "obx",
            ) as OutboxRecord["outboxId"],
            kind: "RESUME_DESTINATION",
            tenantId: context.tenantId,
            aggregateType: "DESTINATION",
            aggregateId: destination.destinationId,
            target: "DELIVERY_QUEUE",
            payload: {
              destinationId: destination.destinationId,
              correlationId: context.correlationId,
            },
            createdAt: this.dependencies.clock.now().toISOString() as never,
            attempts: 0,
            schemaVersion: 1,
          }
        : undefined,
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
      version: 1,
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
  public async updateSubscription(
    context: TenantContext,
    existing: Subscription,
    expectedVersion: number,
    input: { readonly enabled: boolean },
  ): Promise<Subscription> {
    const subscription: Subscription = {
      ...existing,
      enabled: input.enabled,
      version: existing.version + 1,
    };
    const result = await this.dependencies.repository.updateSubscription(
      context,
      subscription,
      expectedVersion,
      this.audit(
        context,
        "subscription.updated",
        "SUBSCRIPTION",
        subscription.subscriptionId,
        {
          version: subscription.version,
        },
      ),
    );
    if (result !== "updated")
      throw new Error(
        result === "not_found" ? "NOT_FOUND" : "PRECONDITION_FAILED",
      );
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
  readonly telemetry?: Telemetry;
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
      ...(this.dependencies.telemetry?.traceparent() === undefined
        ? {}
        : { traceparent: this.dependencies.telemetry.traceparent() }),
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
    if (result.kind === "accepted")
      (this.dependencies.telemetry ?? noopTelemetry).count("events.accepted");
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
  readonly telemetry?: Telemetry;
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
          expiresAt: delivery.expiresAt,
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
          ...(this.dependencies.telemetry?.traceparent() === undefined
            ? {}
            : { traceparent: this.dependencies.telemetry.traceparent() }),
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
            expiresAt: delivery.expiresAt,
          },
        });
      }
    }
    void created;
    (this.dependencies.telemetry ?? noopTelemetry).count(
      "routing.completed",
      1,
      {
        deliveriesCreated: created,
      },
    );
    await this.dependencies.repository.completeRouting(context, event.eventId);
  }
}

export function redactedJson(
  value: JsonObject,
  paths: readonly string[],
): JsonObject {
  return redactJsonValue(value, paths);
}

export interface ReplayDependencies {
  readonly core: CoreRepository;
  readonly repository: OperationsRepository;
  readonly execute: (
    definition: JsonObject,
    event: JsonObject,
  ) => {
    readonly output: JsonObject;
    readonly hash: string;
  };
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly retentionDays: number;
  readonly telemetry?: Telemetry;
}
export class ReplayService {
  public constructor(private readonly dependencies: ReplayDependencies) {}
  public async replay(
    context: TenantContext,
    input: {
      readonly deliveryId: DeliveryExecution["deliveryId"];
      readonly idempotencyKey: string;
      readonly reason: string;
      readonly correctionConfirmed: boolean;
    },
  ) {
    if (
      context.actorType !== "console_user" ||
      (context.role !== "admin" && context.role !== "operator")
    )
      throw new Error("FORBIDDEN");
    const original = await this.dependencies.core.getDelivery(
      context,
      input.deliveryId,
    );
    if (original === undefined) throw new Error("NOT_FOUND");
    const eligibility = replayEligibility({
      state: original.state,
      ...(original.lastFailureCategory === undefined
        ? {}
        : { failureCategory: original.lastFailureCategory }),
      correctionConfirmed: input.correctionConfirmed,
    });
    if (!eligibility.eligible) throw new Error("REPLAY_NOT_ELIGIBLE");
    const event = await this.dependencies.core.getEvent(
      context,
      original.eventId,
    );
    const destination = await this.dependencies.core.getDestination(
      context,
      original.destinationId,
    );
    const partner =
      destination === undefined
        ? undefined
        : await this.dependencies.core.getPartner(
            context,
            destination.partnerId,
          );
    const transformation =
      destination === undefined
        ? undefined
        : await this.dependencies.core.getTransformationVersion(
            context,
            destination.transformationId,
            destination.activeTransformationVersion,
          );
    if (
      event === undefined ||
      destination === undefined ||
      !destination.enabled ||
      partner === undefined ||
      !partner.enabled ||
      transformation === undefined
    )
      throw new Error("REPLAY_CONFIGURATION_UNAVAILABLE");
    let transformed: { readonly output: JsonObject; readonly hash: string };
    try {
      transformed = this.dependencies.execute(
        transformation.definition,
        event as unknown as JsonObject,
      );
    } catch {
      throw new Error("REPLAY_TRANSFORMATION_FAILED");
    }
    const now = this.dependencies.clock.now();
    const at = now.toISOString() as DeliveryExecution["createdAt"];
    const replayId = this.dependencies.ids.next("rpl") as ReplayId;
    const deliveryId = this.dependencies.ids.next(
      "dlv",
    ) as DeliveryExecution["deliveryId"];
    const snapshot = {
      destinationVersion: destination.version,
      url: new URL(destination.path, destination.baseUrl).toString(),
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
        ? { idempotencyHeader: destination.authConfiguration.idempotencyHeader }
        : {}),
    } as DeliveryExecution["configSnapshot"];
    const expiresAt = new Date(
      now.getTime() + this.dependencies.retentionDays * 86_400_000,
    ).toISOString() as DeliveryExecution["expiresAt"];
    const delivery: DeliveryExecution = {
      deliveryId,
      eventId: event.eventId,
      correlationId: event.correlationId,
      tenantId: event.tenantId,
      partnerId: destination.partnerId,
      destinationId: destination.destinationId,
      executionType: "REPLAY",
      originalDeliveryId: original.deliveryId,
      replayId,
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
      expiresAt,
    };
    const relation: ReplayRelation = {
      replayId,
      tenantId: context.tenantId,
      eventId: event.eventId,
      originalDeliveryId: original.deliveryId,
      replayDeliveryId: deliveryId,
      requestedAt: at,
      requestedBy: context.actorId,
      reason: input.reason,
      correctionConfirmed: input.correctionConfirmed,
      originalDestinationVersion: original.configSnapshot.destinationVersion,
      originalTransformationId: original.configSnapshot.transformationId,
      originalTransformationVersion:
        original.configSnapshot.transformationVersion,
      replayDestinationVersion: snapshot.destinationVersion,
      replayTransformationId: snapshot.transformationId,
      replayTransformationVersion: snapshot.transformationVersion,
      expiresAt,
    };
    const requestHash = createHash("sha256")
      .update(
        `${original.deliveryId}\n${input.reason}\n${input.correctionConfirmed}`,
      )
      .digest("hex");
    const idempotencyKeyHash = createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex");
    const result = await this.dependencies.repository.createReplay({
      context,
      requestHash,
      idempotencyKeyHash,
      relation,
      delivery,
      history: {
        historyId: this.dependencies.ids.next("req"),
        deliveryId,
        tenantId: context.tenantId,
        correlationId: event.correlationId,
        type: "replay_linked",
        occurredAt: at,
        summary: "Replay delivery created and scheduled.",
        metadata: { originalDeliveryId: original.deliveryId, replayId },
        expiresAt,
      },
      outbox: {
        outboxId: this.dependencies.ids.next("obx") as OutboxRecord["outboxId"],
        kind: "DELIVER",
        tenantId: context.tenantId,
        aggregateType: "DELIVERY",
        aggregateId: deliveryId,
        target: "DELIVERY_QUEUE",
        payload: {
          eventId: event.eventId,
          deliveryId,
          correlationId: event.correlationId,
          cause: "REPLAY",
        },
        createdAt: at,
        attempts: 0,
        ...(this.dependencies.telemetry?.traceparent() === undefined
          ? {}
          : { traceparent: this.dependencies.telemetry.traceparent() }),
        schemaVersion: 1,
      },
      audit: {
        auditId: this.dependencies.ids.next("aud") as AuditEvent["auditId"],
        tenantId: context.tenantId,
        actorId: context.actorId,
        actorRole: context.role,
        action: "delivery.replay_requested",
        targetType: "DELIVERY",
        targetId: original.deliveryId,
        requestId: context.requestId,
        correlationId: event.correlationId,
        reason: input.reason,
        metadata: {
          replayId,
          replayDeliveryId: deliveryId,
          correctionConfirmed: input.correctionConfirmed,
          originalDestinationVersion:
            original.configSnapshot.destinationVersion,
          replayDestinationVersion: snapshot.destinationVersion,
          originalTransformationVersion:
            original.configSnapshot.transformationVersion,
          replayTransformationVersion: snapshot.transformationVersion,
        },
        occurredAt: at,
        expiresAt: new Date(
          now.getTime() + 90 * 86_400_000,
        ).toISOString() as never,
      },
    });
    if (result.kind === "conflict") throw new Error("IDEMPOTENCY_KEY_REUSED");
    if (result.kind === "created")
      (this.dependencies.telemetry ?? noopTelemetry).count("replay.requested");
    return {
      replayId: result.replayId,
      deliveryId: result.delivery.deliveryId,
      originalDeliveryId: original.deliveryId,
      state: "scheduled" as const,
      previouslyAccepted: result.kind === "duplicate",
    };
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
  readonly random?: { next(): number };
  readonly telemetry?: Telemetry;
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
  }): Promise<{
    readonly acknowledge: boolean;
    readonly delaySeconds?: number;
  }> {
    const context = routingContext(input.tenantId, input.correlationId);
    const initial = await this.dependencies.core.getDelivery(
      context,
      input.deliveryId,
    );
    if (initial === undefined || isTerminalDeliveryState(initial.state))
      return { acknowledge: true };
    const now = this.dependencies.clock.now();
    if (
      initial.state === "in_progress" &&
      initial.leaseExpiresAt !== undefined &&
      new Date(initial.leaseExpiresAt).getTime() <= now.getTime()
    ) {
      await this.dependencies.repository.recoverExpired({
        context,
        eventId: input.eventId,
        deliveryId: input.deliveryId,
        now,
        random: this.dependencies.random?.next() ?? Math.random(),
      });
      return { acknowledge: true };
    }
    if (
      initial.nextEligibleAt !== undefined &&
      new Date(initial.nextEligibleAt).getTime() > now.getTime()
    ) {
      return {
        acknowledge: false,
        delaySeconds: Math.max(
          1,
          Math.ceil(
            (new Date(initial.nextEligibleAt).getTime() - now.getTime()) /
              1_000,
          ),
        ),
      };
    }
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
    // A concurrent worker owns the durable lease, so this duplicate message is
    // safe to acknowledge: the owner (or expired-lease recovery) remains durable.
    if (leased === undefined || leased.leaseToken !== token)
      return { acknowledge: true };
    const defer = async (
      to: "scheduled" | "rate_limited",
      category: FailureCategory,
      at: Date,
      summary: string,
    ) => {
      const transition = transitionDelivery(leased, {
        to,
        at: now.toISOString() as never,
        expectedVersion: leased.version,
        leaseToken: leased.leaseToken ?? (token as never),
        nextEligibleAt: at.toISOString() as never,
        blockedReason: category,
      });
      const outbox: OutboxRecord = {
        outboxId: this.dependencies.ids.next("obx") as OutboxRecord["outboxId"],
        kind: "SCHEDULE_DELIVERY",
        tenantId: leased.tenantId,
        aggregateType: "DELIVERY",
        aggregateId: leased.deliveryId,
        target: "SCHEDULER",
        payload: {
          eventId: leased.eventId,
          deliveryId: leased.deliveryId,
          correlationId: leased.correlationId,
          notBefore: at.toISOString(),
          cause: "RESUME",
        },
        createdAt: now.toISOString() as never,
        attempts: 0,
        ...(this.dependencies.telemetry?.traceparent() === undefined
          ? {}
          : { traceparent: this.dependencies.telemetry.traceparent() }),
        schemaVersion: 1,
      };
      await this.dependencies.repository.defer({
        context,
        eventId: leased.eventId,
        delivery: transition,
        expectedVersion: leased.version,
        leaseToken: leased.leaseToken ?? token,
        history: {
          historyId: this.dependencies.ids.next("req"),
          deliveryId: leased.deliveryId,
          tenantId: leased.tenantId,
          correlationId: leased.correlationId,
          type:
            category === "RATE_LIMITED"
              ? "rate_limited"
              : category === "CIRCUIT_OPEN"
                ? "circuit_open"
                : "destination_disabled",
          occurredAt: now.toISOString() as never,
          summary,
          metadata: {
            failureCategory: category,
            nextEligibleAt: at.toISOString(),
          },
          expiresAt: leased.expiresAt,
        },
        outbox,
      });
    };
    const destination = await this.dependencies.core.getDestination(
      context,
      leased.destinationId,
    );
    if (destination === undefined || !destination.enabled) {
      await defer(
        "scheduled",
        "DESTINATION_DISABLED",
        new Date(now.getTime() + 300_000),
        "Destination is disabled; delivery deferred.",
      );
      return { acknowledge: true };
    }
    const circuit = await this.dependencies.repository.acquireCircuitPermit({
      context,
      destinationId: leased.destinationId,
      policy: destination.circuitBreakerPolicy,
      owner: input.owner,
      now,
    });
    if (!circuit.allowed) {
      await defer(
        "scheduled",
        "CIRCUIT_OPEN",
        circuit.nextEligibleAt ?? new Date(now.getTime() + 5_000),
        "Circuit is open; delivery deferred.",
      );
      return { acknowledge: true };
    }
    const rate = await this.dependencies.repository.acquireRatePermit({
      context,
      destinationId: leased.destinationId,
      policy: destination.rateLimitPolicy,
      now,
    });
    if (!rate.permitted) {
      await defer(
        "rate_limited",
        "RATE_LIMITED",
        rate.nextEligibleAt,
        "Destination rate limit deferred delivery.",
      );
      return { acknowledge: true };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const started = this.dependencies.clock.now();
    const body = JSON.stringify(leased.transformedPayload);
    const attempt: DeliveryAttempt = {
      attemptId: this.dependencies.ids.next(
        "att",
      ) as DeliveryAttempt["attemptId"],
      attemptNumber: leased.attemptCount + 1,
      deliveryId: leased.deliveryId,
      correlationId: leased.correlationId,
      startedAt: started.toISOString() as never,
      requestMethod: leased.configSnapshot.method,
      requestUrl: leased.configSnapshot.url,
      requestHeadersRedacted: {},
      requestBodyHash: createHash("sha256").update(body).digest("hex"),
      outcome: "started",
      ...(this.dependencies.telemetry?.traceId() === undefined
        ? {}
        : { traceId: this.dependencies.telemetry.traceId() }),
      expiresAt: leased.expiresAt,
    };
    const startedDelivery = await this.dependencies.repository.startAttempt({
      context,
      eventId: leased.eventId,
      delivery: leased,
      expectedVersion: leased.version,
      attempt,
    });
    if (startedDelivery === undefined) return { acknowledge: true };
    let response: Awaited<ReturnType<PartnerHttpClient["send"]>> | undefined;
    let errorCode: string | undefined;
    try {
      const secretName = startedDelivery.configSnapshot.secretReferenceNames[0];
      if (secretName === undefined) throw new Error("SECRET_NOT_FOUND");
      const secret = await this.dependencies.secrets.resolve(context, {
        name: secretName,
      });
      if (startedDelivery.configSnapshot.authType === "api_key") {
        const headerName =
          startedDelivery.configSnapshot.authConfiguration.headerName;
        if (typeof headerName !== "string")
          throw new Error("INVALID_DESTINATION");
        headers[headerName] = secret.value;
        if (startedDelivery.configSnapshot.idempotencyHeader !== undefined)
          headers[startedDelivery.configSnapshot.idempotencyHeader] =
            startedDelivery.partnerIdempotencyKey;
      } else {
        const configuration = startedDelivery.configSnapshot.authConfiguration;
        if (
          typeof configuration.tokenUrl !== "string" ||
          typeof configuration.clientId !== "string" ||
          (configuration.authenticationStyle !== "basic" &&
            configuration.authenticationStyle !== "body") ||
          !Array.isArray(configuration.scopes)
        )
          throw new Error("INVALID_DESTINATION");
        headers.authorization = `Bearer ${await this.dependencies.oauth.get({
          destinationId: startedDelivery.destinationId,
          tokenUrl: configuration.tokenUrl,
          clientId: configuration.clientId,
          clientSecret: secret.value,
          scopes: configuration.scopes.filter(
            (scope): scope is string => typeof scope === "string",
          ),
          authenticationStyle: configuration.authenticationStyle,
          correlationId: startedDelivery.correlationId,
        })}`;
        headers["x-delivery-key"] = startedDelivery.partnerIdempotencyKey;
      }
      response = await this.dependencies.http.send({
        url: startedDelivery.configSnapshot.url,
        method: startedDelivery.configSnapshot.method,
        headers,
        body,
        timeoutMs: startedDelivery.configSnapshot.timeoutMs,
        correlationId: startedDelivery.correlationId,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "UNKNOWN";
      errorCode = /TIMEOUT/.test(code)
        ? "TIMEOUT"
        : /DNS|ENOTFOUND|EAI_AGAIN/.test(code)
          ? "DNS_ERROR"
          : /ECONN|CONNECTION/.test(code)
            ? "CONNECTION_ERROR"
            : /TLS|CERT/.test(code)
              ? "TLS_ERROR"
              : /RESPONSE_TOO_LARGE/.test(code)
                ? "RESPONSE_TOO_LARGE"
                : /INVALID_|UNSAFE|REDIRECT|ENCODED/.test(code)
                  ? "RESPONSE_CONTRACT_ERROR"
                  : /SECRET_NOT_FOUND/.test(code)
                    ? "SECRET_NOT_FOUND"
                    : /OAUTH/.test(code)
                      ? "OAUTH_TOKEN_ERROR"
                      : "UNKNOWN";
    }
    const completed = this.dependencies.clock.now();
    const classification = classifyDeliveryResult({
      ...(response === undefined
        ? { errorCode: errorCode ?? "UNKNOWN" }
        : { status: response.status }),
    });
    const retryAfter =
      response === undefined
        ? undefined
        : parseRetryAfter(response.headers["retry-after"], completed);
    const delay = classification.retryable
      ? retryDelaySeconds({
          policy: startedDelivery.configSnapshot.retryPolicy,
          attemptNumber: startedDelivery.attemptCount,
          random: this.dependencies.random?.next() ?? Math.random(),
          ...(retryAfter === undefined
            ? {}
            : { retryAfterSeconds: retryAfter }),
        })
      : undefined;
    const exhausted =
      classification.retryable &&
      startedDelivery.attemptCount >= startedDelivery.maxAttempts;
    const state = classification.success
      ? "succeeded"
      : exhausted
        ? "dead_lettered"
        : classification.retryable
          ? "retry_scheduled"
          : "failed_terminal";
    const nextEligibleAt =
      delay === undefined
        ? undefined
        : new Date(completed.getTime() + Math.ceil(delay * 1_000));
    const delivery = transitionDelivery(startedDelivery, {
      to: state,
      at: completed.toISOString() as never,
      expectedVersion: startedDelivery.version,
      leaseToken: startedDelivery.leaseToken ?? (token as never),
      ...(nextEligibleAt === undefined
        ? {}
        : { nextEligibleAt: nextEligibleAt.toISOString() as never }),
      ...(classification.failureCategory === undefined
        ? {}
        : { blockedReason: classification.failureCategory }),
    });
    const evidence =
      response === undefined
        ? undefined
        : responseEvidence(
            response.headers,
            response.body,
            startedDelivery.configSnapshot.redactionPaths,
          );
    const completedAttempt: DeliveryAttempt = {
      ...attempt,
      completedAt: completed.toISOString() as never,
      durationMs: completed.getTime() - started.getTime(),
      requestHeadersRedacted: redactedHeaders(headers),
      ...(response === undefined || evidence === undefined
        ? {}
        : {
            responseStatus: response.status,
            responseHeadersRedacted: evidence.headers,
            responseBodyExcerptRedacted: evidence.bodyExcerpt,
            responseBodyHash: evidence.bodyHash,
          }),
      outcome: classification.success ? "succeeded" : "failed",
      ...(classification.failureCategory === undefined
        ? {}
        : { failureCategory: classification.failureCategory }),
      retryable: classification.retryable,
    };
    const outbox =
      nextEligibleAt === undefined
        ? undefined
        : {
            outboxId: this.dependencies.ids.next(
              "obx",
            ) as OutboxRecord["outboxId"],
            kind: "SCHEDULE_DELIVERY" as const,
            tenantId: startedDelivery.tenantId,
            aggregateType: "DELIVERY" as const,
            aggregateId: startedDelivery.deliveryId,
            target: "SCHEDULER" as const,
            payload: {
              eventId: startedDelivery.eventId,
              deliveryId: startedDelivery.deliveryId,
              correlationId: startedDelivery.correlationId,
              notBefore: nextEligibleAt.toISOString(),
              cause: "RETRY",
            },
            createdAt: completed.toISOString() as never,
            attempts: 0,
            ...(this.dependencies.telemetry?.traceparent() === undefined
              ? {}
              : { traceparent: this.dependencies.telemetry.traceparent() }),
            schemaVersion: 1 as const,
          };
    const circuitAfter = this.dependencies.repository.circuitAfterAttempt({
      current: circuit.state,
      policy: destination.circuitBreakerPolicy,
      now: completed,
      success: classification.success,
      countsTowardCircuit: classification.countsTowardCircuit,
      probe: circuit.probe,
    });
    const finalized = await this.dependencies.repository.finalizeAttempt({
      context,
      eventId: startedDelivery.eventId,
      delivery,
      expectedVersion: startedDelivery.version,
      leaseToken: startedDelivery.leaseToken ?? token,
      attempt: completedAttempt,
      history: {
        historyId: this.dependencies.ids.next("req"),
        deliveryId: startedDelivery.deliveryId,
        tenantId: startedDelivery.tenantId,
        correlationId: startedDelivery.correlationId,
        type:
          state === "dead_lettered"
            ? "dead_lettered"
            : state === "retry_scheduled"
              ? "retry_scheduled"
              : "state_transition",
        occurredAt: completed.toISOString() as never,
        summary: classification.success
          ? "Delivery succeeded."
          : exhausted
            ? "Delivery retries exhausted."
            : classification.retryable
              ? "Delivery retry scheduled."
              : "Delivery failed terminally.",
        metadata: {
          state,
          failureCategory: classification.failureCategory ?? "UNKNOWN",
          ...(nextEligibleAt === undefined
            ? {}
            : { nextEligibleAt: nextEligibleAt.toISOString() }),
        },
        expiresAt: startedDelivery.expiresAt,
      },
      ...(outbox === undefined ? {} : { outbox }),
      circuit: circuitAfter,
    });
    if (!finalized) throw new Error("DELIVERY_FINALIZATION_CONFLICT");
    const telemetry = this.dependencies.telemetry ?? noopTelemetry;
    telemetry.count("delivery.attempts", 1, {
      executionType: startedDelivery.executionType,
      destination: startedDelivery.destinationId,
    });
    telemetry.duration("delivery.duration", completedAttempt.durationMs ?? 0, {
      outcome: completedAttempt.outcome,
      executionType: startedDelivery.executionType,
      destination: startedDelivery.destinationId,
    });
    telemetry.count(
      classification.success
        ? "delivery.success"
        : state === "dead_lettered"
          ? "delivery.dead_lettered"
          : state === "retry_scheduled"
            ? "delivery.retry_scheduled"
            : "delivery.failure",
      1,
      {
        executionType: startedDelivery.executionType,
        destination: startedDelivery.destinationId,
        ...(classification.failureCategory === undefined
          ? {}
          : { failureCategory: classification.failureCategory }),
      },
    );
    if (startedDelivery.executionType === "REPLAY")
      telemetry.count(
        classification.success ? "replay.succeeded" : "replay.failed",
      );
    return { acknowledge: true };
  }
}
