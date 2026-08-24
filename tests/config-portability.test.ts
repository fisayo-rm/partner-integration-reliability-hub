import { expect, test } from "vitest";
import type { TenantContext } from "../packages/domain/src/index.js";
import {
  bundleDigest,
  ConfigurationPortabilityService,
  parseConfigurationBundle,
  serializeConfigurationBundle,
} from "../packages/config-portability/src/index.js";

const bundle = {
  schemaVersion: 1,
  kind: "PartnerIntegrationHubConfiguration",
  metadata: {
    bundleId: "cfgb_01J0A1B2C3D4E5F6G7H8J9K0MN",
    exportedAt: "2026-08-23T00:00:00.000Z",
    sourceEnvironment: "local",
    tenantExternalKey: "tenant-demo",
  },
  resources: {
    tenantSettings: {},
    partners: [{ externalKey: "partner", name: "Partner", enabled: true }],
    transformations: [
      {
        externalKey: "shipment-v1",
        versions: [
          {
            version: 1,
            definition: {
              schemaVersion: 1,
              contentType: "application/json",
              mappings: [
                { target: "$.id", source: "$.eventId", required: true },
              ],
            },
          },
        ],
      },
    ],
    destinations: [
      {
        externalKey: "partner-hook",
        partnerExternalKey: "partner",
        name: "Partner hook",
        baseUrl: "https://example.test",
        path: "/hook",
        method: "POST",
        enabled: true,
        auth: {
          type: "api_key",
          headerName: "X-API-Key",
          idempotencyHeader: "Idempotency-Key",
          secretAlias: "partner-api-key",
        },
        timeoutMs: 1000,
        retryPolicy: {
          maxAttempts: 2,
          initialDelaySeconds: 1,
          multiplier: 2,
          maxDelaySeconds: 10,
          jitter: "FULL_UPPER_HALF",
        },
        rateLimitPolicy: {
          requestsPerInterval: 1,
          intervalSeconds: 1,
          burstCapacity: 1,
          safetyFactor: 1,
        },
        circuitBreakerPolicy: {
          failureThreshold: 2,
          cooldownSeconds: 1,
          probeLeaseSeconds: 1,
        },
        transformationExternalKey: "shipment-v1",
        activeTransformationVersion: 1,
        sensitiveResponseJsonPaths: [],
      },
    ],
    subscriptions: [
      {
        externalKey: "shipment-status",
        destinationExternalKey: "partner-hook",
        eventType: "shipment.status_changed",
        enabled: true,
      },
    ],
  },
};

test("M09 bundles are deterministic, YAML/JSON equivalent, and alias-only", () => {
  const parsed = parseConfigurationBundle(bundle);
  const yaml = serializeConfigurationBundle(parsed);
  expect(parseConfigurationBundle(yaml)).toEqual(parsed);
  expect(bundleDigest(parseConfigurationBundle(JSON.stringify(bundle)))).toBe(
    bundleDigest(parsed),
  );
  expect(yaml).toContain("secretAlias: partner-api-key");
  expect(yaml).not.toContain("api-key-value");
});

test("M09 rejects forbidden secret fields", () => {
  expect(() =>
    parseConfigurationBundle({ ...bundle, secret: "not-allowed" }),
  ).toThrow("schema");
});

test("M09 plan receipts fail closed when tampered or presented by another actor", async () => {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const service = new ConfigurationPortabilityService({
    repository: {
      getTenant: async () => ({ externalKey: "tenant-demo" }),
      getPartnerByExternalKey: async () => undefined,
      getDestinationByExternalKey: async () => undefined,
      getSubscriptionByExternalKey: async () => undefined,
      getTransformationByExternalKey: async () => undefined,
    } as never,
    service: {} as never,
    secrets: { isBound: async () => true } as never,
    audit: { append: async () => undefined } as never,
    ids: {
      next: (prefix: string) => `${prefix}_01J0A1B2C3D4E5F6G7H8J9K0MN`,
    } as never,
    sourceEnvironment: "test",
    planSigningKeyBase64: Buffer.alloc(32, 3).toString("base64"),
    now: () => now,
  });
  const actor: TenantContext = {
    tenantId: "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
    actorType: "console_user" as const,
    actorId: "admin-a",
    role: "admin" as const,
    requestId: "req_01J0A1B2C3D4E5F6G7H8J9K0MN",
    correlationId: "cor_01J0A1B2C3D4E5F6G7H8J9K0MN" as never,
  };
  const plan = await service.plan(actor, bundle);
  await expect(
    service.apply(actor, bundle, `${plan.receipt}x`),
  ).rejects.toMatchObject({ code: "INVALID_PLAN_RECEIPT" });
  await expect(
    service.apply({ ...actor, actorId: "admin-b" }, bundle, plan.receipt),
  ).rejects.toMatchObject({ code: "INVALID_PLAN_RECEIPT" });
});
