/** Pure business types and policies. This package intentionally has no runtime adapters. */

declare const brand: unique symbol;
export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};
export type TenantId = Brand<string, "TenantId">;
export type EventId = Brand<string, "EventId">;
export type PartnerId = Brand<string, "PartnerId">;
export type DestinationId = Brand<string, "DestinationId">;
export type DeliveryId = Brand<string, "DeliveryId">;
export type AttemptId = Brand<string, "AttemptId">;
export type AuditId = Brand<string, "AuditId">;
export type OutboxId = Brand<string, "OutboxId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type ReplayId = Brand<string, "ReplayId">;
export type TransformationId = Brand<string, "TransformationId">;
export type SubscriptionId = Brand<string, "SubscriptionId">;
export type ClientId = Brand<string, "ClientId">;
export type LeaseToken = Brand<string, "LeaseToken">;
export type IsoInstant = Brand<string, "IsoInstant">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type ActorRole = "admin" | "operator" | "viewer";
export type ActorType = "console_user" | "api_client" | "system";
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly role?: ActorRole;
  readonly requestId: string;
  readonly correlationId: CorrelationId;
}

export interface Tenant {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly status: "active" | "disabled";
  readonly createdAt: IsoInstant;
  readonly version: number;
}
export interface UserIdentityMapping {
  readonly issuer: string;
  readonly subject: string;
  readonly tenantId: TenantId;
  readonly status: "active" | "disabled";
  /** The database mapping is authoritative and cannot be elevated by token claims. */
  readonly role: ActorRole;
  readonly userId: string;
}
export interface ApiClientSecretVersion {
  readonly reference: SecretReference;
  readonly state: "active" | "grace";
  readonly activatedAt: IsoInstant;
  readonly graceExpiresAt?: IsoInstant;
}
export interface ApiClient {
  readonly clientId: ClientId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly status: "active" | "disabled";
  readonly scopes: readonly string[];
  readonly secretVersions: readonly ApiClientSecretVersion[];
  readonly createdAt: IsoInstant;
  readonly version: number;
}

export interface SubjectReference {
  readonly type: string;
  readonly id: string;
}

export type EventStatus =
  | "accepted"
  | "processing"
  | "partially_succeeded"
  | "succeeded"
  | "failed"
  | "no_destinations";

export interface EventOutcomeCounters {
  readonly routingComplete: boolean;
  readonly totalDeliveries: number;
  readonly terminalDeliveries: number;
  readonly successfulDeliveries: number;
  readonly failedTerminalDeliveries: number;
  readonly deadLetteredDeliveries: number;
}

export interface CanonicalEvent {
  readonly eventId: EventId;
  readonly tenantId: TenantId;
  readonly producerClientId: ClientId;
  readonly correlationId: CorrelationId;
  readonly eventType: string;
  readonly occurredAt: IsoInstant;
  readonly acceptedAt: IsoInstant;
  readonly subject: SubjectReference;
  readonly data: JsonObject;
  readonly metadata: JsonObject;
  readonly payloadHash: string;
  readonly outcome: EventOutcomeCounters;
  readonly expiresAt: IsoInstant;
}

export interface Partner {
  readonly partnerId: PartnerId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
  readonly version: number;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelaySeconds: number;
  readonly multiplier: number;
  readonly maxDelaySeconds: number;
  readonly jitter: "FULL_UPPER_HALF";
}
export interface RateLimitPolicy {
  readonly requestsPerInterval: number;
  readonly intervalSeconds: number;
  readonly burstCapacity: number;
  readonly safetyFactor: number;
}
export interface CircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly cooldownSeconds: number;
  readonly probeLeaseSeconds: number;
}
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
export interface CircuitRuntimeState {
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly openedAt?: IsoInstant;
  readonly nextProbeAt?: IsoInstant;
  readonly probeLeaseOwner?: string;
  readonly probeLeaseExpiresAt?: IsoInstant;
  readonly version: number;
}
export type DestinationAuthType = "api_key" | "oauth_client_credentials";
export interface SecretReference {
  readonly name: string;
  readonly version?: string;
}
export interface Destination {
  readonly destinationId: DestinationId;
  readonly partnerId: PartnerId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly baseUrl: string;
  readonly path: string;
  readonly method: "POST";
  readonly enabled: boolean;
  readonly authType: DestinationAuthType;
  readonly authConfiguration: JsonObject;
  readonly secretReferences: readonly SecretReference[];
  readonly timeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  readonly rateLimitPolicy: RateLimitPolicy;
  readonly circuitBreakerPolicy: CircuitBreakerPolicy;
  readonly transformationId: TransformationId;
  readonly activeTransformationVersion: number;
  readonly sensitiveResponseJsonPaths: readonly string[];
  readonly version: number;
}
export interface DestinationConfigurationVersion {
  readonly destinationId: DestinationId;
  readonly tenantId: TenantId;
  readonly version: number;
  readonly configuration: Destination;
  readonly createdAt: IsoInstant;
}
export interface TransformationVersion {
  readonly transformationId: TransformationId;
  readonly tenantId: TenantId;
  readonly version: number;
  readonly definition: JsonObject;
  readonly createdAt: IsoInstant;
  readonly createdBy: string;
}
export interface Subscription {
  readonly subscriptionId: SubscriptionId;
  readonly tenantId: TenantId;
  readonly destinationId: DestinationId;
  readonly eventType: string;
  readonly enabled: boolean;
  readonly createdAt: IsoInstant;
}

export type DeliveryState =
  | "pending"
  | "scheduled"
  | "rate_limited"
  | "in_progress"
  | "retry_scheduled"
  | "succeeded"
  | "failed_terminal"
  | "dead_lettered"
  | "cancelled";
export const terminalDeliveryStates: ReadonlySet<DeliveryState> = new Set([
  "succeeded",
  "failed_terminal",
  "dead_lettered",
  "cancelled",
]);
export type FailureCategory =
  | "TRANSFORMATION_ERROR"
  | "INVALID_DESTINATION"
  | "DESTINATION_DISABLED"
  | "SECRET_NOT_FOUND"
  | "OAUTH_TOKEN_ERROR"
  | "DNS_ERROR"
  | "CONNECTION_ERROR"
  | "TLS_ERROR"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "PARTNER_4XX"
  | "PARTNER_5XX"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_CONTRACT_ERROR"
  | "CIRCUIT_OPEN"
  | "INTERNAL_PERSISTENCE_ERROR"
  | "UNKNOWN";
export const failureCategories: readonly FailureCategory[] = [
  "TRANSFORMATION_ERROR",
  "INVALID_DESTINATION",
  "DESTINATION_DISABLED",
  "SECRET_NOT_FOUND",
  "OAUTH_TOKEN_ERROR",
  "DNS_ERROR",
  "CONNECTION_ERROR",
  "TLS_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "PARTNER_4XX",
  "PARTNER_5XX",
  "RESPONSE_TOO_LARGE",
  "RESPONSE_CONTRACT_ERROR",
  "CIRCUIT_OPEN",
  "INTERNAL_PERSISTENCE_ERROR",
  "UNKNOWN",
];
export interface DeliveryConfigurationSnapshot {
  readonly destinationVersion: number;
  readonly url: string;
  readonly method: "POST";
  readonly timeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  readonly rateLimitPolicyId: string;
  readonly circuitBreakerPolicyId: string;
  readonly authType: DestinationAuthType;
  readonly secretReferenceNames: readonly string[];
  readonly transformationId: TransformationId;
  readonly transformationVersion: number;
  readonly redactionPaths: readonly string[];
  readonly idempotencyHeader?: string;
}
export interface DeliveryExecution {
  readonly deliveryId: DeliveryId;
  readonly eventId: EventId;
  readonly tenantId: TenantId;
  readonly partnerId: PartnerId;
  readonly destinationId: DestinationId;
  readonly executionType: "ORIGINAL" | "REPLAY";
  readonly originalDeliveryId?: DeliveryId;
  readonly replayId?: ReplayId;
  readonly state: DeliveryState;
  readonly blockedReason?: FailureCategory;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextEligibleAt?: IsoInstant;
  readonly leaseOwner?: string;
  readonly leaseToken?: LeaseToken;
  readonly leaseAcquiredAt?: IsoInstant;
  readonly leaseExpiresAt?: IsoInstant;
  readonly configSnapshot: DeliveryConfigurationSnapshot;
  readonly transformedPayload: JsonObject;
  readonly transformedPayloadHash: string;
  readonly partnerIdempotencyKey: string;
  readonly lastFailureCategory?: FailureCategory;
  readonly createdAt: IsoInstant;
  readonly updatedAt: IsoInstant;
  readonly terminalAt?: IsoInstant;
  readonly version: number;
  readonly expiresAt: IsoInstant;
}
export interface DeliveryAttempt {
  readonly attemptId: AttemptId;
  readonly attemptNumber: number;
  readonly deliveryId: DeliveryId;
  readonly startedAt: IsoInstant;
  readonly completedAt?: IsoInstant;
  readonly durationMs?: number;
  readonly requestMethod: "POST";
  readonly requestUrl: string;
  readonly requestHeadersRedacted: Readonly<Record<string, string>>;
  readonly requestBodyHash: string;
  readonly responseStatus?: number;
  readonly responseHeadersRedacted?: Readonly<Record<string, string>>;
  readonly responseBodyExcerptRedacted?: string;
  readonly responseBodyHash?: string;
  readonly outcome: "started" | "succeeded" | "failed";
  readonly failureCategory?: FailureCategory;
  readonly retryable?: boolean;
  readonly traceId?: string;
}
export interface DeliveryHistoryEntry {
  readonly historyId: string;
  readonly deliveryId: DeliveryId;
  readonly tenantId: TenantId;
  readonly type:
    | "created"
    | "queued"
    | "rate_limited"
    | "circuit_open"
    | "lease_recovered"
    | "retry_scheduled"
    | "destination_disabled"
    | "dead_lettered"
    | "replay_linked"
    | "state_transition";
  readonly occurredAt: IsoInstant;
  readonly summary: string;
  readonly metadata: JsonObject;
}
export interface AuditEvent {
  readonly auditId: AuditId;
  readonly tenantId: TenantId;
  readonly actorId: string;
  readonly actorRole?: ActorRole;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly requestId: string;
  readonly correlationId: CorrelationId;
  readonly reason?: string;
  readonly metadata: JsonObject;
  readonly occurredAt: IsoInstant;
  readonly expiresAt: IsoInstant;
}
export type OutboxKind =
  | "ROUTE_EVENT"
  | "DELIVER"
  | "SCHEDULE_DELIVERY"
  | "RESUME_DELIVERY"
  | "RESUME_DESTINATION"
  | "RECONCILE_EVENT_STATUS";
export interface OutboxRecord {
  readonly outboxId: OutboxId;
  readonly kind: OutboxKind;
  readonly tenantId: TenantId;
  readonly aggregateType: "EVENT" | "DELIVERY" | "DESTINATION";
  readonly aggregateId: string;
  readonly target: "ROUTING_QUEUE" | "DELIVERY_QUEUE" | "SCHEDULER";
  readonly payload: JsonObject;
  readonly createdAt: IsoInstant;
  readonly attempts: number;
  readonly publishedAt?: IsoInstant;
  readonly schemaVersion: 1;
}

export class DomainError extends Error {
  public constructor(
    readonly code:
      | "INVALID_TRANSITION"
      | "INVALID_EVENT_COUNTERS"
      | "INVALID_POLICY"
      | "INVALID_IDENTIFIER",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export function isTerminalDeliveryState(state: DeliveryState): boolean {
  return terminalDeliveryStates.has(state);
}
export function validatePolicy(
  policy: RetryPolicy | RateLimitPolicy | CircuitBreakerPolicy,
): void {
  for (const value of Object.values(policy)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0))
      throw new DomainError(
        "INVALID_POLICY",
        "Policy values must be positive finite numbers.",
      );
  }
  if (
    "maxAttempts" in policy &&
    (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1)
  )
    throw new DomainError(
      "INVALID_POLICY",
      "maxAttempts must be a positive integer.",
    );
  if ("safetyFactor" in policy && policy.safetyFactor > 1)
    throw new DomainError("INVALID_POLICY", "safetyFactor must be at most 1.");
}
export function deriveEventStatus(counters: EventOutcomeCounters): EventStatus {
  const values = Object.values(counters).filter(
    (value): value is number => typeof value === "number",
  );
  if (
    values.some((value) => !Number.isInteger(value) || value < 0) ||
    counters.terminalDeliveries > counters.totalDeliveries ||
    counters.successfulDeliveries +
      counters.failedTerminalDeliveries +
      counters.deadLetteredDeliveries !==
      counters.terminalDeliveries
  )
    throw new DomainError(
      "INVALID_EVENT_COUNTERS",
      "Event outcome counters are inconsistent.",
    );
  if (!counters.routingComplete)
    return counters.totalDeliveries === 0 ? "accepted" : "processing";
  if (counters.totalDeliveries === 0) return "no_destinations";
  if (counters.terminalDeliveries < counters.totalDeliveries)
    return "processing";
  if (counters.successfulDeliveries === counters.totalDeliveries)
    return "succeeded";
  return counters.successfulDeliveries > 0 ? "partially_succeeded" : "failed";
}
export interface DeliveryTransition {
  readonly to: DeliveryState;
  readonly at: IsoInstant;
  readonly expectedVersion: number;
  readonly leaseToken?: LeaseToken;
  readonly nextEligibleAt?: IsoInstant;
  readonly blockedReason?: FailureCategory;
  readonly lease?: {
    readonly owner: string;
    readonly token: LeaseToken;
    readonly expiresAt: IsoInstant;
  };
}
const permittedTransitions: Readonly<
  Record<DeliveryState, readonly DeliveryState[]>
> = {
  pending: ["scheduled"],
  scheduled: ["scheduled", "in_progress", "rate_limited"],
  rate_limited: ["scheduled"],
  in_progress: [
    "succeeded",
    "retry_scheduled",
    "failed_terminal",
    "dead_lettered",
  ],
  retry_scheduled: ["scheduled"],
  succeeded: [],
  failed_terminal: [],
  dead_lettered: [],
  cancelled: [],
};
export function transitionDelivery(
  delivery: DeliveryExecution,
  transition: DeliveryTransition,
): DeliveryExecution {
  if (delivery.version !== transition.expectedVersion)
    throw new DomainError(
      "INVALID_TRANSITION",
      "Delivery version does not match expected version.",
    );
  if (!permittedTransitions[delivery.state].includes(transition.to))
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot transition ${delivery.state} to ${transition.to}.`,
    );
  if (transition.to === "in_progress" && !transition.lease)
    throw new DomainError(
      "INVALID_TRANSITION",
      "Entering in_progress requires a lease.",
    );
  if (
    delivery.state === "in_progress" &&
    delivery.leaseToken !== transition.leaseToken
  )
    throw new DomainError(
      "INVALID_TRANSITION",
      "Leaving in_progress requires the active lease token.",
    );
  if (
    ["scheduled", "retry_scheduled", "rate_limited"].includes(transition.to) &&
    !transition.nextEligibleAt
  )
    throw new DomainError(
      "INVALID_TRANSITION",
      "Deferred delivery states require nextEligibleAt.",
    );
  const unchangedDelivery = { ...delivery } as {
    -readonly [Key in keyof DeliveryExecution]: DeliveryExecution[Key];
  };
  delete unchangedDelivery.blockedReason;
  delete unchangedDelivery.nextEligibleAt;
  delete unchangedDelivery.terminalAt;
  delete unchangedDelivery.leaseOwner;
  delete unchangedDelivery.leaseToken;
  delete unchangedDelivery.leaseAcquiredAt;
  delete unchangedDelivery.leaseExpiresAt;
  return {
    ...unchangedDelivery,
    state: transition.to,
    updatedAt: transition.at,
    version: delivery.version + 1,
    ...(transition.blockedReason === undefined
      ? {}
      : { blockedReason: transition.blockedReason }),
    ...(transition.nextEligibleAt === undefined
      ? {}
      : { nextEligibleAt: transition.nextEligibleAt }),
    ...(isTerminalDeliveryState(transition.to)
      ? { terminalAt: transition.at }
      : {}),
    ...(transition.lease === undefined
      ? {}
      : {
          leaseOwner: transition.lease.owner,
          leaseToken: transition.lease.token,
          leaseAcquiredAt: transition.at,
          leaseExpiresAt: transition.lease.expiresAt,
        }),
  };
}
export function asIdentifier<T extends string>(
  prefix: string,
  value: string,
): Brand<string, T> {
  if (!new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value))
    throw new DomainError(
      "INVALID_IDENTIFIER",
      `Expected ${prefix}_ followed by a ULID.`,
    );
  return value as Brand<string, T>;
}
