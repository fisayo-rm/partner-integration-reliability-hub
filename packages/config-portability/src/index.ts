import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  type AuditRepository,
  type CoreRepository,
  type ControlPlaneRepository,
  type IdGenerator,
  type SecretStore,
  type TenantRepository,
  ControlPlaneService,
} from "@pirh/application";
import { transformationDefinitionSchema } from "@pirh/contracts";
import type {
  AuditEvent,
  Destination,
  JsonObject,
  TenantContext,
} from "@pirh/domain";

const externalKey = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_-]*$/);
const retryPolicy = z
  .object({
    maxAttempts: z.number().int().positive(),
    initialDelaySeconds: z.number().positive(),
    multiplier: z.number().positive(),
    maxDelaySeconds: z.number().positive(),
    jitter: z.literal("FULL_UPPER_HALF"),
  })
  .strict();
const rateLimitPolicy = z
  .object({
    requestsPerInterval: z.number().int().positive(),
    intervalSeconds: z.number().positive(),
    burstCapacity: z.number().int().positive(),
    safetyFactor: z.number().positive().max(1),
  })
  .strict();
const circuitBreakerPolicy = z
  .object({
    failureThreshold: z.number().int().positive(),
    cooldownSeconds: z.number().positive(),
    probeLeaseSeconds: z.number().positive(),
  })
  .strict();
const apiKeyAuth = z
  .object({
    type: z.literal("api_key"),
    headerName: z.string().regex(/^X-[A-Za-z0-9-]{1,64}$/),
    idempotencyHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    secretAlias: externalKey,
  })
  .strict();
const oauthAuth = z
  .object({
    type: z.literal("oauth_client_credentials"),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1).max(256),
    scopes: z.array(z.string().min(1).max(128)).max(20),
    authenticationStyle: z.enum(["basic", "body"]),
    secretAlias: externalKey,
  })
  .strict();
const bundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("PartnerIntegrationHubConfiguration"),
    metadata: z
      .object({
        bundleId: z.string().regex(/^cfgb_[A-Za-z0-9_-]{8,}$/),
        exportedAt: z.string().datetime({ offset: true }),
        sourceEnvironment: z.string().min(1).max(64),
        tenantExternalKey: externalKey,
      })
      .strict(),
    resources: z
      .object({
        tenantSettings: z.object({}).strict(),
        partners: z.array(
          z
            .object({
              externalKey,
              name: z.string().min(1).max(128),
              description: z.string().max(1024).optional(),
              enabled: z.boolean(),
            })
            .strict(),
        ),
        destinations: z.array(
          z
            .object({
              externalKey,
              partnerExternalKey: externalKey,
              name: z.string().min(1).max(128),
              baseUrl: z.string().url(),
              path: z.string().regex(/^\/[A-Za-z0-9_./-]*$/),
              method: z.literal("POST"),
              enabled: z.boolean(),
              auth: z.discriminatedUnion("type", [apiKeyAuth, oauthAuth]),
              timeoutMs: z.number().int().min(100).max(30_000),
              retryPolicy,
              rateLimitPolicy,
              circuitBreakerPolicy,
              transformationExternalKey: externalKey,
              activeTransformationVersion: z.number().int().positive(),
              sensitiveResponseJsonPaths: z.array(z.string().max(512)).max(50),
            })
            .strict(),
        ),
        transformations: z.array(
          z
            .object({
              externalKey,
              versions: z
                .array(
                  z
                    .object({
                      version: z.number().int().positive(),
                      definition: z.record(z.string(), z.unknown()),
                    })
                    .strict(),
                )
                .min(1),
            })
            .strict(),
        ),
        subscriptions: z.array(
          z
            .object({
              externalKey,
              destinationExternalKey: externalKey,
              eventType: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[a-z][a-z0-9_.-]*$/),
              enabled: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export type ConfigurationBundleV1 = z.infer<typeof bundleSchema>;
export type PlanAction =
  | "CREATE"
  | "UPDATE"
  | "UNCHANGED"
  | "CONFLICT"
  | "BLOCKED";
export interface ConfigurationPlanItem {
  readonly resourceType:
    | "partner"
    | "transformation"
    | "destination"
    | "subscription";
  readonly externalKey: string;
  readonly version?: number;
  readonly action: PlanAction;
  readonly reason?: string;
  /**
   * Digest of the target state observed while producing the receipt. This is
   * deliberately non-sensitive and makes a receipt fail closed on concurrent
   * mutations, including mutations which would otherwise retain the same
   * action classification.
   */
  readonly targetFingerprint: string;
}
export interface ConfigurationPlan {
  readonly bundleId: string;
  readonly digest: string;
  readonly items: readonly ConfigurationPlanItem[];
  readonly receipt: string;
  readonly expiresAt: string;
}
export interface ApplyResult {
  readonly bundleId: string;
  readonly digest: string;
  readonly items: readonly (ConfigurationPlanItem & {
    readonly outcome: "APPLIED" | "SKIPPED";
  })[];
}
export class ConfigurationPortabilityError extends Error {
  public constructor(
    public readonly code:
      | "VALIDATION_ERROR"
      | "PLAN_DRIFT"
      | "INVALID_PLAN_RECEIPT",
    message: string,
  ) {
    super(message);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function bundleDigest(bundle: ConfigurationBundleV1): string {
  return createHash("sha256").update(canonical(bundle)).digest("hex");
}
function sortByKey<T extends { readonly externalKey: string }>(
  values: readonly T[],
): T[] {
  return [...values].sort((left, right) =>
    left.externalKey.localeCompare(right.externalKey),
  );
}
function normalized(bundle: ConfigurationBundleV1): ConfigurationBundleV1 {
  return {
    ...bundle,
    resources: {
      ...bundle.resources,
      partners: sortByKey(bundle.resources.partners),
      destinations: sortByKey(bundle.resources.destinations),
      subscriptions: sortByKey(bundle.resources.subscriptions),
      transformations: sortByKey(bundle.resources.transformations).map(
        (transformation) => ({
          ...transformation,
          versions: [...transformation.versions].sort(
            (left, right) => left.version - right.version,
          ),
        }),
      ),
    },
  };
}
function rejectForbidden(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}/.test(
      serialized,
    )
  )
    throw new ConfigurationPortabilityError(
      "VALIDATION_ERROR",
      "Bundle contains forbidden secret-like material.",
    );
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (current === null || typeof current !== "object") return;
    for (const [key, child] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (
        [
          "clientSecret",
          "accessToken",
          "apiKey",
          "password",
          "credential",
          "secretReferences",
        ].includes(key)
      )
        throw new ConfigurationPortabilityError(
          "VALIDATION_ERROR",
          "Bundle contains a forbidden field.",
        );
      visit(child);
    }
  };
  visit(value);
}
export function parseConfigurationBundle(
  input: string | unknown,
): ConfigurationBundleV1 {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      value = parseYaml(input);
    }
  }
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success)
    throw new ConfigurationPortabilityError(
      "VALIDATION_ERROR",
      "Configuration bundle schema validation failed.",
    );
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 128 * 1024)
    throw new ConfigurationPortabilityError(
      "VALIDATION_ERROR",
      "Configuration bundle exceeds 128 KiB.",
    );
  rejectForbidden(parsed.data);
  for (const transformation of parsed.data.resources.transformations)
    for (const version of transformation.versions)
      if (!transformationDefinitionSchema.safeParse(version.definition).success)
        throw new ConfigurationPortabilityError(
          "VALIDATION_ERROR",
          "Transformation definition is invalid.",
        );
  const duplicate = (values: readonly { readonly externalKey: string }[]) =>
    new Set(values.map((value) => value.externalKey)).size !== values.length;
  if (
    duplicate(parsed.data.resources.partners) ||
    duplicate(parsed.data.resources.destinations) ||
    duplicate(parsed.data.resources.transformations) ||
    duplicate(parsed.data.resources.subscriptions)
  )
    throw new ConfigurationPortabilityError(
      "VALIDATION_ERROR",
      "External keys must be unique within each resource type.",
    );
  return normalized(parsed.data);
}
export function serializeConfigurationBundle(
  bundle: ConfigurationBundleV1,
): string {
  const value = normalized(bundle);
  rejectForbidden(value);
  return stringifyYaml(value, { lineWidth: 0, sortMapEntries: true });
}

interface ReceiptPayload {
  readonly tenantId: string;
  readonly actorId: string;
  readonly bundleId: string;
  readonly digest: string;
  readonly planHash: string;
  readonly expiresAt: string;
}
function receipt(payload: ReceiptPayload, key: Buffer): string {
  const encoded = Buffer.from(canonical(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}
function verifyReceipt(value: string, key: Buffer): ReceiptPayload {
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature)
    throw new ConfigurationPortabilityError(
      "INVALID_PLAN_RECEIPT",
      "Plan receipt is invalid.",
    );
  const expected = createHmac("sha256", key)
    .update(encoded)
    .digest("base64url");
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  )
    throw new ConfigurationPortabilityError(
      "INVALID_PLAN_RECEIPT",
      "Plan receipt is invalid.",
    );
  try {
    return JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as ReceiptPayload;
  } catch {
    throw new ConfigurationPortabilityError(
      "INVALID_PLAN_RECEIPT",
      "Plan receipt is invalid.",
    );
  }
}

export interface ConfigurationPortabilityDependencies {
  readonly repository: ControlPlaneRepository &
    CoreRepository &
    TenantRepository;
  readonly service: ControlPlaneService;
  readonly secrets: SecretStore;
  readonly audit: AuditRepository;
  readonly ids: IdGenerator;
  readonly sourceEnvironment: string;
  readonly planSigningKeyBase64: string;
  readonly now?: () => Date;
}
export class ConfigurationPortabilityService {
  private readonly signingKey: Buffer;
  private readonly now: () => Date;
  public constructor(
    private readonly dependencies: ConfigurationPortabilityDependencies,
  ) {
    this.signingKey = Buffer.from(dependencies.planSigningKeyBase64, "base64");
    if (
      this.signingKey.length !== 32 ||
      this.signingKey.toString("base64") !== dependencies.planSigningKeyBase64
    )
      throw new Error(
        "PORTABILITY_PLAN_SIGNING_KEY_B64 must be a canonical base64 32-byte key.",
      );
    this.now = dependencies.now ?? (() => new Date());
  }
  private audit(
    context: TenantContext,
    action: string,
    targetId: string,
    metadata: JsonObject,
  ): AuditEvent {
    const at = this.now().toISOString() as never;
    return {
      auditId: this.dependencies.ids.next("aud") as never,
      tenantId: context.tenantId,
      actorId: context.actorId,
      ...(context.role === undefined ? {} : { actorRole: context.role }),
      action,
      targetType: "CONFIGURATION_BUNDLE",
      targetId,
      requestId: context.requestId,
      correlationId: context.correlationId,
      metadata,
      occurredAt: at,
      expiresAt: new Date(
        this.now().getTime() + 90 * 86_400_000,
      ).toISOString() as never,
    };
  }
  private async all<T>(
    load: (cursor?: string) => Promise<{
      readonly items: readonly T[];
      readonly cursor?: string | undefined;
    }>,
  ): Promise<readonly T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await load(cursor);
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);
    return items;
  }
  public async export(
    context: TenantContext,
    expectedTenantExternalKey?: string,
  ): Promise<{
    readonly bundle: ConfigurationBundleV1;
    readonly yaml: string;
    readonly digest: string;
  }> {
    const tenant = await this.dependencies.repository.getTenant(context);
    if (
      tenant === undefined ||
      (expectedTenantExternalKey !== undefined &&
        tenant.externalKey !== expectedTenantExternalKey)
    )
      throw new ConfigurationPortabilityError(
        "VALIDATION_ERROR",
        "Tenant does not match the authenticated tenant.",
      );
    const partners = await this.all((cursor) =>
      this.dependencies.repository.listPartners(context, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const destinations = await this.all((cursor) =>
      this.dependencies.repository.listDestinations(context, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const subscriptions = await this.all((cursor) =>
      this.dependencies.repository.listControlSubscriptions(context, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const summaries = await this.all((cursor) =>
      this.dependencies.repository.listTransformations(context, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const transformationKeys = new Map(
      summaries.map((value) => [value.transformationId, value.externalKey]),
    );
    const partnerKeys = new Map(
      partners.map((value) => [value.partnerId, value.externalKey]),
    );
    const destinationKeys = new Map(
      destinations.map((value) => [value.destinationId, value.externalKey]),
    );
    const transformations = await Promise.all(
      summaries.map(async (summary) => ({
        externalKey: summary.externalKey,
        versions: (
          await this.all((cursor) =>
            this.dependencies.repository.listTransformationVersions(
              context,
              summary.transformationId,
              { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
            ),
          )
        ).map((version) => ({
          version: version.version,
          definition: version.definition,
        })),
      })),
    );
    const bundle = normalized({
      schemaVersion: 1,
      kind: "PartnerIntegrationHubConfiguration",
      metadata: {
        bundleId: `cfgb_${this.dependencies.ids.next("req").slice(4)}`,
        exportedAt: this.now().toISOString(),
        sourceEnvironment: this.dependencies.sourceEnvironment,
        tenantExternalKey: tenant.externalKey,
      },
      resources: {
        tenantSettings: {},
        partners: partners.map((value) => ({
          externalKey: value.externalKey,
          name: value.name,
          ...(value.description === undefined
            ? {}
            : { description: value.description }),
          enabled: value.enabled,
        })),
        destinations: destinations.map((value) => {
          const alias = value.secretReferences[0]?.name;
          const partnerExternalKey = partnerKeys.get(value.partnerId);
          const transformationExternalKey = transformationKeys.get(
            value.transformationId,
          );
          if (
            alias === undefined ||
            partnerExternalKey === undefined ||
            transformationExternalKey === undefined
          )
            throw new ConfigurationPortabilityError(
              "VALIDATION_ERROR",
              "Control-plane configuration cannot be represented safely.",
            );
          const auth =
            value.authType === "api_key"
              ? {
                  type: "api_key" as const,
                  headerName: String(value.authConfiguration.headerName),
                  idempotencyHeader: String(
                    value.authConfiguration.idempotencyHeader,
                  ),
                  secretAlias: alias,
                }
              : {
                  type: "oauth_client_credentials" as const,
                  tokenUrl: String(value.authConfiguration.tokenUrl),
                  clientId: String(value.authConfiguration.clientId),
                  scopes: Array.isArray(value.authConfiguration.scopes)
                    ? value.authConfiguration.scopes.map(String)
                    : [],
                  authenticationStyle:
                    value.authConfiguration.authenticationStyle === "body"
                      ? ("body" as const)
                      : ("basic" as const),
                  secretAlias: alias,
                };
          return {
            externalKey: value.externalKey,
            partnerExternalKey,
            name: value.name,
            baseUrl: value.baseUrl,
            path: value.path,
            method: value.method,
            enabled: value.enabled,
            auth,
            timeoutMs: value.timeoutMs,
            retryPolicy: value.retryPolicy,
            rateLimitPolicy: value.rateLimitPolicy,
            circuitBreakerPolicy: value.circuitBreakerPolicy,
            transformationExternalKey,
            activeTransformationVersion: value.activeTransformationVersion,
            sensitiveResponseJsonPaths: [...value.sensitiveResponseJsonPaths],
          };
        }),
        transformations,
        subscriptions: subscriptions.map((value) => {
          const destinationExternalKey = destinationKeys.get(
            value.destinationId,
          );
          if (destinationExternalKey === undefined)
            throw new ConfigurationPortabilityError(
              "VALIDATION_ERROR",
              "Subscription reference cannot be represented safely.",
            );
          return {
            externalKey: value.externalKey,
            destinationExternalKey,
            eventType: value.eventType,
            enabled: value.enabled,
          };
        }),
      },
    });
    const yaml = serializeConfigurationBundle(bundle);
    const digest = bundleDigest(bundle);
    await this.dependencies.audit.append(
      this.audit(context, "configuration.exported", bundle.metadata.bundleId, {
        digest,
        tenantExternalKey: tenant.externalKey,
      }),
    );
    return { bundle, yaml, digest };
  }
  public async validate(
    context: TenantContext,
    raw: unknown,
  ): Promise<ConfigurationBundleV1> {
    const bundle = parseConfigurationBundle(raw);
    const tenant = await this.dependencies.repository.getTenant(context);
    if (
      tenant === undefined ||
      tenant.externalKey !== bundle.metadata.tenantExternalKey
    )
      throw new ConfigurationPortabilityError(
        "VALIDATION_ERROR",
        "Bundle tenant does not match the authenticated tenant.",
      );
    const transformations = new Map(
      bundle.resources.transformations.map((value) => [
        value.externalKey,
        value,
      ]),
    );
    const partners = new Set(
      bundle.resources.partners.map((value) => value.externalKey),
    );
    const destinations = new Set(
      bundle.resources.destinations.map((value) => value.externalKey),
    );
    for (const destination of bundle.resources.destinations)
      if (
        !partners.has(destination.partnerExternalKey) ||
        !transformations.has(destination.transformationExternalKey) ||
        !transformations
          .get(destination.transformationExternalKey)
          ?.versions.some(
            (value) =>
              value.version === destination.activeTransformationVersion,
          )
      )
        throw new ConfigurationPortabilityError(
          "VALIDATION_ERROR",
          "Bundle has an unresolved resource reference.",
        );
    for (const subscription of bundle.resources.subscriptions)
      if (!destinations.has(subscription.destinationExternalKey))
        throw new ConfigurationPortabilityError(
          "VALIDATION_ERROR",
          "Bundle has an unresolved subscription reference.",
        );
    return bundle;
  }
  private planHash(items: readonly ConfigurationPlanItem[]): string {
    return createHash("sha256").update(canonical(items)).digest("hex");
  }
  private destinationComparable(destination: Destination) {
    const alias = destination.secretReferences[0]?.name;
    const auth =
      destination.authType === "api_key"
        ? {
            type: "api_key",
            headerName: destination.authConfiguration.headerName,
            idempotencyHeader: destination.authConfiguration.idempotencyHeader,
            secretAlias: alias,
          }
        : {
            type: "oauth_client_credentials",
            tokenUrl: destination.authConfiguration.tokenUrl,
            clientId: destination.authConfiguration.clientId,
            scopes: destination.authConfiguration.scopes,
            authenticationStyle:
              destination.authConfiguration.authenticationStyle,
            secretAlias: alias,
          };
    return {
      name: destination.name,
      baseUrl: destination.baseUrl,
      path: destination.path,
      method: destination.method,
      enabled: destination.enabled,
      auth,
      timeoutMs: destination.timeoutMs,
      retryPolicy: destination.retryPolicy,
      rateLimitPolicy: destination.rateLimitPolicy,
      circuitBreakerPolicy: destination.circuitBreakerPolicy,
      activeTransformationVersion: destination.activeTransformationVersion,
      sensitiveResponseJsonPaths: destination.sensitiveResponseJsonPaths,
    };
  }
  private destinationComparableBundle(
    destination: ConfigurationBundleV1["resources"]["destinations"][number],
  ) {
    return {
      name: destination.name,
      baseUrl: destination.baseUrl,
      path: destination.path,
      method: destination.method,
      enabled: destination.enabled,
      auth: destination.auth,
      timeoutMs: destination.timeoutMs,
      retryPolicy: destination.retryPolicy,
      rateLimitPolicy: destination.rateLimitPolicy,
      circuitBreakerPolicy: destination.circuitBreakerPolicy,
      activeTransformationVersion: destination.activeTransformationVersion,
      sensitiveResponseJsonPaths: destination.sensitiveResponseJsonPaths,
    };
  }
  public async plan(
    context: TenantContext,
    raw: unknown,
  ): Promise<ConfigurationPlan> {
    const bundle = await this.validate(context, raw);
    const items: ConfigurationPlanItem[] = [];
    const destinationAction = new Map<string, PlanAction>();
    for (const partner of bundle.resources.partners) {
      const current =
        await this.dependencies.repository.getPartnerByExternalKey(
          context,
          partner.externalKey,
        );
      const same =
        current !== undefined &&
        canonical({
          name: current.name,
          description: current.description,
          enabled: current.enabled,
        }) ===
          canonical({
            name: partner.name,
            description: partner.description,
            enabled: partner.enabled,
          });
      items.push({
        resourceType: "partner",
        externalKey: partner.externalKey,
        action:
          current === undefined ? "CREATE" : same ? "UNCHANGED" : "UPDATE",
        targetFingerprint: fingerprint(
          current === undefined
            ? { state: "absent" }
            : {
                state: "present",
                version: current.version,
                name: current.name,
                description: current.description,
                enabled: current.enabled,
              },
        ),
      });
    }
    for (const transformation of bundle.resources.transformations) {
      const current =
        await this.dependencies.repository.getTransformationByExternalKey(
          context,
          transformation.externalKey,
        );
      for (const version of transformation.versions) {
        const existing =
          current === undefined
            ? undefined
            : await this.dependencies.repository.getTransformationVersion(
                context,
                current.transformationId,
                version.version,
              );
        const conflict =
          existing !== undefined &&
          canonical(existing.definition) !== canonical(version.definition);
        items.push({
          resourceType: "transformation",
          externalKey: transformation.externalKey,
          version: version.version,
          action:
            existing === undefined
              ? "CREATE"
              : conflict
                ? "CONFLICT"
                : "UNCHANGED",
          ...(conflict ? { reason: "IMMUTABLE_VERSION_MISMATCH" } : {}),
          targetFingerprint: fingerprint(
            existing === undefined
              ? { state: "absent" }
              : {
                  state: "present",
                  version: existing.version,
                  definition: existing.definition,
                },
          ),
        });
      }
    }
    for (const destination of bundle.resources.destinations) {
      const current =
        await this.dependencies.repository.getDestinationByExternalKey(
          context,
          destination.externalKey,
        );
      const partner =
        await this.dependencies.repository.getPartnerByExternalKey(
          context,
          destination.partnerExternalKey,
        );
      const transformation =
        await this.dependencies.repository.getTransformationByExternalKey(
          context,
          destination.transformationExternalKey,
        );
      const aliasBound = await this.dependencies.secrets.isBound(
        context,
        destination.auth.secretAlias,
      );
      let action: PlanAction = "CREATE";
      let reason: string | undefined;
      const parentConflict = items.some(
        (item) =>
          item.action === "CONFLICT" &&
          ((item.resourceType === "partner" &&
            item.externalKey === destination.partnerExternalKey) ||
            (item.resourceType === "transformation" &&
              item.externalKey === destination.transformationExternalKey &&
              item.version === destination.activeTransformationVersion)),
      );
      if (parentConflict) {
        action = "BLOCKED";
        reason = "DEPENDENCY_BLOCKED";
      } else if (destination.enabled && !aliasBound) {
        action = "BLOCKED";
        reason = "UNRESOLVED_SECRET_ALIAS";
      } else if (
        current !== undefined &&
        ((partner !== undefined && current.partnerId !== partner.partnerId) ||
          current.authType !== destination.auth.type)
      ) {
        action = "CONFLICT";
        reason = "IDENTITY_MISMATCH";
      } else if (current !== undefined)
        action =
          canonical(this.destinationComparable(current)) ===
            canonical(this.destinationComparableBundle(destination)) &&
          (transformation === undefined ||
            current.transformationId === transformation.transformationId)
            ? "UNCHANGED"
            : "UPDATE";
      destinationAction.set(destination.externalKey, action);
      items.push({
        resourceType: "destination",
        externalKey: destination.externalKey,
        action,
        ...(reason === undefined ? {} : { reason }),
        targetFingerprint: fingerprint(
          current === undefined
            ? { state: "absent" }
            : {
                state: "present",
                version: current.version,
                partnerId: current.partnerId,
                transformationId: current.transformationId,
                configuration: this.destinationComparable(current),
              },
        ),
      });
    }
    for (const subscription of bundle.resources.subscriptions) {
      const current =
        await this.dependencies.repository.getSubscriptionByExternalKey(
          context,
          subscription.externalKey,
        );
      const destination =
        await this.dependencies.repository.getDestinationByExternalKey(
          context,
          subscription.destinationExternalKey,
        );
      const dependency = destinationAction.get(
        subscription.destinationExternalKey,
      );
      let action: PlanAction = "CREATE";
      let reason: string | undefined;
      if (dependency === "BLOCKED" || dependency === "CONFLICT") {
        action = "BLOCKED";
        reason = "DEPENDENCY_BLOCKED";
      } else if (
        current !== undefined &&
        ((destination !== undefined &&
          current.destinationId !== destination.destinationId) ||
          current.eventType !== subscription.eventType)
      ) {
        action = "CONFLICT";
        reason = "IDENTITY_MISMATCH";
      } else if (current !== undefined)
        action =
          current.enabled === subscription.enabled ? "UNCHANGED" : "UPDATE";
      items.push({
        resourceType: "subscription",
        externalKey: subscription.externalKey,
        action,
        ...(reason === undefined ? {} : { reason }),
        targetFingerprint: fingerprint(
          current === undefined
            ? { state: "absent" }
            : {
                state: "present",
                version: current.version,
                destinationId: current.destinationId,
                eventType: current.eventType,
                enabled: current.enabled,
              },
        ),
      });
    }
    const digest = bundleDigest(bundle);
    const expiresAt = new Date(this.now().getTime() + 3_600_000).toISOString();
    const planHash = this.planHash(items);
    return {
      bundleId: bundle.metadata.bundleId,
      digest,
      items,
      expiresAt,
      receipt: receipt(
        {
          tenantId: context.tenantId,
          actorId: context.actorId,
          bundleId: bundle.metadata.bundleId,
          digest,
          planHash,
          expiresAt,
        },
        this.signingKey,
      ),
    };
  }
  public async apply(
    context: TenantContext,
    raw: unknown,
    planReceipt: string,
  ): Promise<ApplyResult> {
    const bundle = await this.validate(context, raw);
    const received = verifyReceipt(planReceipt, this.signingKey);
    const digest = bundleDigest(bundle);
    if (
      received.tenantId !== context.tenantId ||
      received.actorId !== context.actorId ||
      received.bundleId !== bundle.metadata.bundleId ||
      received.digest !== digest ||
      Date.parse(received.expiresAt) <= this.now().getTime()
    )
      throw new ConfigurationPortabilityError(
        "INVALID_PLAN_RECEIPT",
        "Plan receipt does not authorize this import.",
      );
    const plan = await this.plan(context, bundle);
    if (this.planHash(plan.items) !== received.planHash)
      throw new ConfigurationPortabilityError(
        "PLAN_DRIFT",
        "Target configuration changed after planning.",
      );
    const outcomes: (ConfigurationPlanItem & {
      readonly outcome: "APPLIED" | "SKIPPED";
    })[] = [];
    const planned = (
      resourceType: ConfigurationPlanItem["resourceType"],
      externalKey: string,
      version?: number,
    ) =>
      plan.items.find(
        (value) =>
          value.resourceType === resourceType &&
          value.externalKey === externalKey &&
          value.version === version,
      )!;
    for (const partner of bundle.resources.partners) {
      const entry = planned("partner", partner.externalKey);
      const partnerInput = {
        name: partner.name,
        externalKey: partner.externalKey,
        ...(partner.description === undefined
          ? {}
          : { description: partner.description }),
        enabled: partner.enabled,
      };
      if (entry.action === "CREATE")
        await this.dependencies.service.createPartner(context, partnerInput);
      else if (entry.action === "UPDATE") {
        const current =
          await this.dependencies.repository.getPartnerByExternalKey(
            context,
            partner.externalKey,
          );
        if (current !== undefined)
          await this.dependencies.service.updatePartner(
            context,
            current,
            current.version,
            partnerInput,
          );
      }
      outcomes.push({
        ...entry,
        outcome:
          entry.action === "CREATE" || entry.action === "UPDATE"
            ? "APPLIED"
            : "SKIPPED",
      });
    }
    for (const transformation of bundle.resources.transformations)
      for (const version of transformation.versions) {
        const entry = planned(
          "transformation",
          transformation.externalKey,
          version.version,
        );
        if (entry.action === "CREATE") {
          const current =
            await this.dependencies.repository.getTransformationByExternalKey(
              context,
              transformation.externalKey,
            );
          if (current === undefined)
            await this.dependencies.service.createTransformation(context, {
              externalKey: transformation.externalKey,
              definition: version.definition as JsonObject,
            });
          else {
            const latest =
              await this.dependencies.repository.getTransformationVersion(
                context,
                current.transformationId,
                current.latestVersion,
              );
            if (latest !== undefined)
              await this.dependencies.service.createTransformationVersion(
                context,
                latest,
                { definition: version.definition as JsonObject },
              );
          }
        }
        outcomes.push({
          ...entry,
          outcome: entry.action === "CREATE" ? "APPLIED" : "SKIPPED",
        });
      }
    for (const destination of bundle.resources.destinations) {
      const entry = planned("destination", destination.externalKey);
      if (entry.action === "CREATE" || entry.action === "UPDATE") {
        const partner =
          await this.dependencies.repository.getPartnerByExternalKey(
            context,
            destination.partnerExternalKey,
          );
        const transformation =
          await this.dependencies.repository.getTransformationByExternalKey(
            context,
            destination.transformationExternalKey,
          );
        if (partner === undefined || transformation === undefined)
          throw new ConfigurationPortabilityError(
            "PLAN_DRIFT",
            "Import dependency changed.",
          );
        const authConfiguration =
          destination.auth.type === "api_key"
            ? {
                headerName: destination.auth.headerName,
                idempotencyHeader: destination.auth.idempotencyHeader,
              }
            : {
                tokenUrl: destination.auth.tokenUrl,
                clientId: destination.auth.clientId,
                scopes: destination.auth.scopes,
                authenticationStyle: destination.auth.authenticationStyle,
              };
        const value = {
          partnerId: partner.partnerId,
          name: destination.name,
          externalKey: destination.externalKey as Destination["externalKey"],
          baseUrl: destination.baseUrl,
          path: destination.path,
          method: "POST" as const,
          enabled: destination.enabled,
          authType: destination.auth.type,
          authConfiguration,
          timeoutMs: destination.timeoutMs,
          retryPolicy: destination.retryPolicy,
          rateLimitPolicy: destination.rateLimitPolicy,
          circuitBreakerPolicy: destination.circuitBreakerPolicy,
          transformationId: transformation.transformationId,
          activeTransformationVersion: destination.activeTransformationVersion,
          sensitiveResponseJsonPaths: destination.sensitiveResponseJsonPaths,
        };
        const current =
          await this.dependencies.repository.getDestinationByExternalKey(
            context,
            destination.externalKey,
          );
        if (current === undefined)
          await this.dependencies.service.createDestinationFromAlias(context, {
            ...value,
            secretAlias: destination.auth.secretAlias,
          });
        else
          await this.dependencies.service.updateDestination(
            context,
            current,
            current.version,
            {
              ...value,
              credentialAlias: destination.auth.secretAlias,
            } as never,
          );
      }
      outcomes.push({
        ...entry,
        outcome:
          entry.action === "CREATE" || entry.action === "UPDATE"
            ? "APPLIED"
            : "SKIPPED",
      });
    }
    for (const subscription of bundle.resources.subscriptions) {
      const entry = planned("subscription", subscription.externalKey);
      if (entry.action === "CREATE" || entry.action === "UPDATE") {
        const destination =
          await this.dependencies.repository.getDestinationByExternalKey(
            context,
            subscription.destinationExternalKey,
          );
        if (destination === undefined)
          throw new ConfigurationPortabilityError(
            "PLAN_DRIFT",
            "Import dependency changed.",
          );
        const current =
          await this.dependencies.repository.getSubscriptionByExternalKey(
            context,
            subscription.externalKey,
          );
        if (current === undefined)
          await this.dependencies.service.createSubscription(context, {
            externalKey: subscription.externalKey,
            destinationId: destination.destinationId,
            eventType: subscription.eventType,
            enabled: subscription.enabled,
          });
        else
          await this.dependencies.service.updateSubscription(
            context,
            current,
            current.version,
            { enabled: subscription.enabled },
          );
      }
      outcomes.push({
        ...entry,
        outcome:
          entry.action === "CREATE" || entry.action === "UPDATE"
            ? "APPLIED"
            : "SKIPPED",
      });
    }
    await this.dependencies.audit.append(
      this.audit(
        context,
        "configuration.import_applied",
        bundle.metadata.bundleId,
        {
          digest,
          operationCount: outcomes.filter(
            (value) => value.outcome === "APPLIED",
          ).length,
        },
      ),
    );
    return { bundleId: bundle.metadata.bundleId, digest, items: outcomes };
  }
}
