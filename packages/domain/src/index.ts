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
export type ExternalKey = Brand<string, "ExternalKey">;
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
  /** Stable logical identity used by configuration portability. */
  readonly externalKey: ExternalKey;
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
  /** Stored materialization of the outcome counters for efficient status reads. */
  readonly status: EventStatus;
  readonly outcome: EventOutcomeCounters;
  readonly version: number;
  readonly expiresAt: IsoInstant;
}

export interface Partner {
  readonly partnerId: PartnerId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly externalKey: ExternalKey;
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
export interface RateLimitRuntimeState {
  readonly theoreticalArrivalTimeMs: number;
  readonly updatedAt: IsoInstant;
  readonly policyHash: string;
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
  readonly externalKey: ExternalKey;
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
  readonly externalKey: ExternalKey;
  readonly tenantId: TenantId;
  readonly version: number;
  readonly definition: JsonObject;
  readonly createdAt: IsoInstant;
  readonly createdBy: string;
}
export interface Subscription {
  readonly subscriptionId: SubscriptionId;
  readonly externalKey: ExternalKey;
  readonly tenantId: TenantId;
  readonly destinationId: DestinationId;
  readonly eventType: string;
  readonly enabled: boolean;
  readonly createdAt: IsoInstant;
  /** Mutable control-plane records participate in optimistic concurrency. */
  readonly version: number;
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
  /** Non-secret auth settings required to execute the immutable delivery. */
  readonly authConfiguration: JsonObject;
  readonly secretReferenceNames: readonly string[];
  readonly transformationId: TransformationId;
  readonly transformationVersion: number;
  readonly redactionPaths: readonly string[];
  readonly idempotencyHeader?: string;
}
export interface DeliveryExecution {
  readonly deliveryId: DeliveryId;
  readonly eventId: EventId;
  readonly correlationId: CorrelationId;
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
  /** Present only between durable attempt start and conditional finalization. */
  readonly activeAttemptId?: AttemptId;
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
  readonly correlationId: CorrelationId;
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
  readonly traceId?: string | undefined;
  readonly expiresAt: IsoInstant;
}
export interface DeliveryHistoryEntry {
  readonly historyId: string;
  readonly deliveryId: DeliveryId;
  readonly tenantId: TenantId;
  readonly correlationId: CorrelationId;
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
  readonly expiresAt: IsoInstant;
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
/** Immutable link between an original execution and one replay execution. */
export interface ReplayRelation {
  readonly replayId: ReplayId;
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly originalDeliveryId: DeliveryId;
  readonly replayDeliveryId: DeliveryId;
  readonly requestedAt: IsoInstant;
  readonly requestedBy: string;
  readonly reason: string;
  readonly correctionConfirmed: boolean;
  readonly originalDestinationVersion: number;
  readonly originalTransformationId: TransformationId;
  readonly originalTransformationVersion: number;
  readonly replayDestinationVersion: number;
  readonly replayTransformationId: TransformationId;
  readonly replayTransformationVersion: number;
  readonly expiresAt: IsoInstant;
}
export interface OperationalRollup {
  readonly tenantId: TenantId;
  readonly hour: string;
  readonly destinationId?: DestinationId;
  readonly shard?: number;
  readonly acceptedEvents: number;
  readonly deliveryAttempts: number;
  readonly deliverySuccesses: number;
  readonly deliveryFailures: number;
  readonly retriesScheduled: number;
  readonly deadLetters: number;
  readonly replaysRequested: number;
  readonly replaySuccesses: number;
  readonly replayFailures: number;
  readonly latencyTotalMs: number;
  readonly latencyCount: number;
  readonly latencyBuckets: Readonly<Record<string, number>>;
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
  /** W3C trace context carried out-of-band in queue message attributes. */
  readonly traceparent?: string | undefined;
  readonly schemaVersion: 1;
}
export interface ScheduledDeliveryWork {
  readonly workId: OutboxId;
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly deliveryId: DeliveryId;
  readonly correlationId: CorrelationId;
  readonly notBefore: IsoInstant;
  readonly cause: "RETRY" | "RESUME";
  readonly createdAt: IsoInstant;
  readonly publishedAt?: IsoInstant;
  readonly traceparent?: string | undefined;
  readonly attempts: number;
  readonly expiresAt: IsoInstant;
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
const replayableTerminalCategories = new Set<FailureCategory>([
  "TRANSFORMATION_ERROR",
  "INVALID_DESTINATION",
  "SECRET_NOT_FOUND",
  "OAUTH_TOKEN_ERROR",
  "PARTNER_4XX",
  "RESPONSE_TOO_LARGE",
  "RESPONSE_CONTRACT_ERROR",
]);
export function replayEligibility(input: {
  readonly state: DeliveryState;
  readonly failureCategory?: FailureCategory;
  readonly correctionConfirmed: boolean;
}): { readonly eligible: boolean; readonly requiresCorrection: boolean } {
  if (input.state === "dead_lettered")
    return { eligible: true, requiresCorrection: false };
  if (
    input.state === "failed_terminal" &&
    input.failureCategory !== undefined &&
    replayableTerminalCategories.has(input.failureCategory)
  )
    return {
      eligible: input.correctionConfirmed,
      requiresCorrection: true,
    };
  return { eligible: false, requiresCorrection: false };
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

export interface DeliveryResultClassification {
  readonly success: boolean;
  readonly retryable: boolean;
  readonly failureCategory?: FailureCategory;
  readonly countsTowardCircuit: boolean;
}
/** Maps stable HTTP/transport categories to the M05 default policy. */
export function classifyDeliveryResult(input: {
  readonly status?: number;
  readonly errorCode?: string;
}): DeliveryResultClassification {
  if (input.status !== undefined) {
    if (input.status >= 200 && input.status < 300)
      return { success: true, retryable: false, countsTowardCircuit: false };
    if ([408, 425, 429, 500, 502, 503, 504].includes(input.status))
      return {
        success: false,
        retryable: true,
        failureCategory: input.status === 429 ? "RATE_LIMITED" : "PARTNER_5XX",
        countsTowardCircuit: [500, 502, 503, 504].includes(input.status),
      };
    return {
      success: false,
      retryable: false,
      failureCategory: "PARTNER_4XX",
      countsTowardCircuit: false,
    };
  }
  const code = input.errorCode ?? "UNKNOWN";
  const classified: Record<string, DeliveryResultClassification> = {
    DNS_ERROR: {
      success: false,
      retryable: true,
      failureCategory: "DNS_ERROR",
      countsTowardCircuit: true,
    },
    CONNECTION_ERROR: {
      success: false,
      retryable: true,
      failureCategory: "CONNECTION_ERROR",
      countsTowardCircuit: true,
    },
    TLS_ERROR: {
      success: false,
      retryable: true,
      failureCategory: "TLS_ERROR",
      countsTowardCircuit: true,
    },
    TIMEOUT: {
      success: false,
      retryable: true,
      failureCategory: "TIMEOUT",
      countsTowardCircuit: true,
    },
    OAUTH_TOKEN_ERROR: {
      success: false,
      retryable: false,
      failureCategory: "OAUTH_TOKEN_ERROR",
      countsTowardCircuit: false,
    },
    SECRET_NOT_FOUND: {
      success: false,
      retryable: false,
      failureCategory: "SECRET_NOT_FOUND",
      countsTowardCircuit: false,
    },
    INVALID_DESTINATION: {
      success: false,
      retryable: false,
      failureCategory: "INVALID_DESTINATION",
      countsTowardCircuit: false,
    },
    RESPONSE_TOO_LARGE: {
      success: false,
      retryable: false,
      failureCategory: "RESPONSE_TOO_LARGE",
      countsTowardCircuit: false,
    },
    RESPONSE_CONTRACT_ERROR: {
      success: false,
      retryable: false,
      failureCategory: "RESPONSE_CONTRACT_ERROR",
      countsTowardCircuit: false,
    },
  };
  return (
    classified[code] ?? {
      success: false,
      retryable: false,
      failureCategory: "UNKNOWN",
      countsTowardCircuit: false,
    }
  );
}

export function parseRetryAfter(
  value: string | undefined,
  now: Date,
): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const result = Math.ceil((at - now.getTime()) / 1_000);
  return result >= 0 ? result : undefined;
}
export function retryDelaySeconds(input: {
  readonly policy: RetryPolicy;
  readonly attemptNumber: number;
  readonly random: number;
  readonly retryAfterSeconds?: number;
}): number {
  const base = Math.min(
    input.policy.maxDelaySeconds,
    input.policy.initialDelaySeconds *
      input.policy.multiplier ** (input.attemptNumber - 1),
  );
  const jittered =
    base * (0.5 + Math.max(0, Math.min(0.999999, input.random)) * 0.5);
  return Math.min(
    input.policy.maxDelaySeconds,
    Math.max(jittered, input.retryAfterSeconds ?? 0),
  );
}

export function rateLimitDecision(input: {
  readonly state?: RateLimitRuntimeState;
  readonly policy: RateLimitPolicy;
  readonly nowMs: number;
}): {
  readonly permitted: boolean;
  readonly nextEligibleAtMs: number;
  readonly nextTheoreticalArrivalTimeMs?: number;
} {
  const increment =
    (input.policy.intervalSeconds * 1_000) /
    (input.policy.requestsPerInterval * input.policy.safetyFactor);
  const tat = input.state?.theoreticalArrivalTimeMs ?? input.nowMs;
  const earliest =
    tat - increment * Math.max(0, input.policy.burstCapacity - 1);
  if (input.nowMs < earliest)
    return { permitted: false, nextEligibleAtMs: Math.ceil(earliest) };
  return {
    permitted: true,
    nextEligibleAtMs: input.nowMs,
    nextTheoreticalArrivalTimeMs: Math.ceil(
      Math.max(input.nowMs, tat) + increment,
    ),
  };
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
    "scheduled",
    "rate_limited",
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
    ...(transition.blockedReason === undefined
      ? {}
      : { lastFailureCategory: transition.blockedReason }),
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
