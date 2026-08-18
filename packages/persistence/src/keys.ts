import { createHash } from "node:crypto";
import type { ClientId, TenantId } from "@pirh/domain";

export const key = {
  tenant: (tenantId: TenantId) => ({ PK: `TENANT#${tenantId}`, SK: "META" }),
  identity: (issuer: string, subject: string) => ({
    PK: `IDENTITY#${createHash("sha256").update(issuer).digest("hex")}#${subject}`,
    SK: "META",
  }),
  apiClient: (tenantId: TenantId, clientId: ClientId) => ({
    PK: `TENANT#${tenantId}`,
    SK: `API_CLIENT#${clientId}`,
  }),
  apiClientLocator: (clientId: ClientId) => ({
    PK: `API_CLIENT#${clientId}`,
    SK: "LOCATOR",
  }),
  partner: (tenantId: TenantId, partnerId: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `PARTNER#${partnerId}`,
  }),
  destination: (tenantId: TenantId, destinationId: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `DESTINATION#${destinationId}`,
  }),
  runtime: (
    tenantId: TenantId,
    destinationId: string,
    name: "RATE_LIMIT" | "CIRCUIT",
  ) => ({
    PK: `TENANT#${tenantId}#DESTINATION#${destinationId}`,
    SK: `RUNTIME#${name}`,
  }),
  transformation: (
    tenantId: TenantId,
    transformationId: string,
    version: number,
  ) => ({
    PK: `TENANT#${tenantId}#TRANSFORMATION#${transformationId}`,
    SK: `VERSION#${String(version).padStart(8, "0")}`,
  }),
  subscription: (
    tenantId: TenantId,
    eventType: string,
    destinationId: string,
  ) => ({
    PK: `TENANT#${tenantId}#EVENT_TYPE#${eventType}`,
    SK: `DESTINATION#${destinationId}`,
  }),
  subscriptionCatalog: (tenantId: TenantId, subscriptionId: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `SUBSCRIPTION#${subscriptionId}`,
  }),
  externalKey: (
    tenantId: TenantId,
    type: "PARTNER" | "DESTINATION" | "TRANSFORMATION" | "SUBSCRIPTION",
    externalKey: string,
  ) => ({
    PK: `TENANT#${tenantId}#EXTERNAL#${type}`,
    SK: `KEY#${externalKey}`,
  }),
  event: (tenantId: TenantId, eventId: string) => ({
    PK: `TENANT#${tenantId}#EVENT#${eventId}`,
    SK: "META",
  }),
  delivery: (tenantId: TenantId, eventId: string, deliveryId: string) => ({
    PK: `TENANT#${tenantId}#EVENT#${eventId}`,
    SK: `DELIVERY#${deliveryId}`,
  }),
  attempt: (
    tenantId: TenantId,
    eventId: string,
    deliveryId: string,
    attempt: number,
  ) => ({
    PK: `TENANT#${tenantId}#EVENT#${eventId}`,
    SK: `DELIVERY#${deliveryId}#ATTEMPT#${String(attempt).padStart(8, "0")}`,
  }),
  history: (
    tenantId: TenantId,
    eventId: string,
    deliveryId: string,
    at: string,
    historyId: string,
  ) => ({
    PK: `TENANT#${tenantId}#EVENT#${eventId}`,
    SK: `DELIVERY#${deliveryId}#HISTORY#${at}#${historyId}`,
  }),
  lookup: (
    tenantId: TenantId,
    kind: "EVENT" | "DELIVERY" | "CORRELATION",
    id: string,
  ) => ({ PK: `TENANT#${tenantId}#LOOKUP`, SK: `${kind}#${id}` }),
  idempotency: (tenantId: TenantId, clientId: ClientId, hash: string) => ({
    PK: `TENANT#${tenantId}#IDEMPOTENCY#${clientId}`,
    SK: `KEY#${hash}`,
  }),
  replayIdempotency: (tenantId: TenantId, hash: string) => ({
    PK: `TENANT#${tenantId}#REPLAY_IDEMPOTENCY`,
    SK: `KEY#${hash}`,
  }),
  nonce: (tenantId: TenantId, clientId: ClientId, hash: string) => ({
    PK: `TENANT#${tenantId}#NONCE#${clientId}`,
    SK: `NONCE#${hash}`,
  }),
  eventIndex: (
    tenantId: TenantId,
    category: string,
    acceptedAt: string,
    eventId: string,
  ) => ({
    PK: `TENANT#${tenantId}#EVENT_INDEX#${category}`,
    SK: `${acceptedAt}#EVENT#${eventId}`,
  }),
  deliveryIndex: (
    tenantId: TenantId,
    category: string,
    updatedAt: string,
    deliveryId: string,
  ) => ({
    PK: `TENANT#${tenantId}#DELIVERY_INDEX#${category}`,
    SK: `${updatedAt}#DELIVERY#${deliveryId}`,
  }),
  replayRelation: (
    tenantId: TenantId,
    eventId: string,
    originalDeliveryId: string,
    replayId: string,
  ) => ({
    PK: `TENANT#${tenantId}#EVENT#${eventId}`,
    SK: `DELIVERY#${originalDeliveryId}#REPLAY#${replayId}`,
  }),
  rollup: (tenantId: TenantId, hour: string, shard?: number) => ({
    PK:
      shard === undefined
        ? `TENANT#${tenantId}#ROLLUP#HOUR#${hour}`
        : `TENANT#${tenantId}#ROLLUP#HOUR#${hour}#SHARD#${shard}`,
    SK: shard === undefined ? "DESTINATION" : "SYSTEM",
  }),
  destinationRollup: (
    tenantId: TenantId,
    hour: string,
    destinationId: string,
  ) => ({
    PK: `TENANT#${tenantId}#ROLLUP#HOUR#${hour}`,
    SK: `DESTINATION#${destinationId}`,
  }),
  outbox: (shard: number, createdAt: string, outboxId: string) => ({
    PK: `OUTBOX#${shard}`,
    SK: `${createdAt}#${outboxId}`,
  }),
  scheduledWork: (shard: number, notBefore: string, workId: string) => ({
    PK: `SCHEDULED_WORK#${shard}`,
    SK: `${notBefore}#${workId}`,
  }),
  audit: (tenantId: TenantId, occurredAt: string, auditId: string) => ({
    PK: `TENANT#${tenantId}`,
    SK: `${occurredAt}#AUDIT#${auditId}`,
  }),
  secret: (tenantId: TenantId, name: string, version: string) => ({
    PK: `TENANT#${tenantId}#SECRET`,
    SK: `SECRET#${name}#VERSION#${version}`,
  }),
};

export function stableShard(value: string, count: number): number {
  let hash = 0;
  for (const character of value)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % count;
}
