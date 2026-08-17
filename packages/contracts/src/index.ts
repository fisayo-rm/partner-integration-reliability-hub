import { z } from "zod";

export const contractVersion = 1 as const;
const ulid = "[0-9A-HJKMNP-TV-Z]{26}";
const identifier = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_${ulid}$`));
const isoInstant = z.string().datetime({ offset: true });
const jsonValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const canonicalEventRequestSchema = z
  .object({
    eventType: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    occurredAt: isoInstant,
    subject: z
      .object({
        type: z.string().min(1).max(64),
        id: z.string().min(1).max(256),
      })
      .strict(),
    data: jsonObjectSchema,
    metadata: jsonObjectSchema.default({}),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > 128 * 1024)
      context.addIssue({
        code: "custom",
        message: "Canonical request must not exceed 128 KiB.",
      });
    if (Buffer.byteLength(JSON.stringify(value.data), "utf8") > 96 * 1024)
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "data must not exceed 96 KiB.",
      });
  });
export type CanonicalEventRequest = z.infer<typeof canonicalEventRequestSchema>;
export const eventAcceptanceResponseSchema = z
  .object({
    eventId: identifier("evt"),
    correlationId: identifier("cor"),
    status: z.literal("accepted"),
    previouslyAccepted: z.boolean(),
    acceptedAt: isoInstant,
  })
  .strict();
export type EventAcceptanceResponse = z.infer<
  typeof eventAcceptanceResponseSchema
>;

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        details: z
          .array(z.object({ path: z.string(), reason: z.string() }).strict())
          .optional(),
        requestId: identifier("req"),
        correlationId: identifier("cor"),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

const queueBase = {
  schemaVersion: z.literal(1),
  tenantId: identifier("tenant"),
  eventId: identifier("evt").optional(),
  deliveryId: identifier("dlv").optional(),
  correlationId: identifier("cor"),
  notBefore: isoInstant.optional(),
};
export const routeEventMessageSchema = z
  .object({
    ...queueBase,
    messageType: z.literal("ROUTE_EVENT"),
    eventId: identifier("evt"),
    cause: z.enum(["INITIAL", "RECONCILE"]),
  })
  .strict();
export const deliverMessageSchema = z
  .object({
    ...queueBase,
    messageType: z.literal("DELIVER"),
    eventId: identifier("evt"),
    deliveryId: identifier("dlv"),
    cause: z.enum(["INITIAL", "RETRY", "REPLAY", "RESUME"]),
  })
  .strict();
export const resumeDestinationMessageSchema = z
  .object({
    ...queueBase,
    messageType: z.literal("RESUME_DESTINATION"),
    destinationId: identifier("dst"),
    cause: z.literal("DESTINATION_ENABLED"),
  })
  .strict();
export const queueMessageSchema = z.discriminatedUnion("messageType", [
  routeEventMessageSchema,
  deliverMessageSchema,
  resumeDestinationMessageSchema,
]);
export type QueueMessage = z.infer<typeof queueMessageSchema>;

export const partnerAlphaPayloadSchema = z
  .object({
    tracking_number: z.string().min(1),
    delivery_status: z.string().min(1),
    estimated_delivery: z.string().date().optional(),
    event_reference: identifier("evt"),
  })
  .strict();
export const partnerBetaPayloadSchema = z
  .object({
    shipment: z
      .object({
        id: z.string().min(1),
        tracking: z.object({ number: z.string().min(1) }).strict(),
        currentState: z.string().min(1),
        estimatedDeliveryDate: z.string().date().optional(),
      })
      .strict(),
    sourceEvent: z
      .object({ id: identifier("evt"), occurredAt: isoInstant })
      .strict(),
  })
  .strict();

const jsonPath = z.string().regex(/^\$\.[A-Za-z0-9_.]+$/);
const valueOperandSchema = z
  .object({ source: jsonPath.optional(), literal: jsonValueSchema.optional() })
  .strict()
  .refine(
    (value) => value.source !== undefined || value.literal !== undefined,
    "Operand requires source or literal.",
  );
const mappingBase = z
  .object({ target: jsonPath, required: z.boolean().optional() })
  .strict();
const directMappingSchema = mappingBase
  .extend({
    source: jsonPath.optional(),
    literal: jsonValueSchema.optional(),
    transform: z
      .enum(["UPPERCASE", "LOWERCASE", "UPPER_SNAKE", "ISO_DATE"])
      .optional(),
  })
  .refine(
    (mapping) => mapping.source !== undefined || mapping.literal !== undefined,
    "Mapping requires source or literal.",
  );
const concatMappingSchema = mappingBase.extend({
  transform: z.literal("CONCAT"),
  parts: z.array(valueOperandSchema).min(1).max(10),
  separator: z.string().max(256).optional(),
});
const enumMappingSchema = mappingBase.extend({
  source: jsonPath,
  transform: z.literal("ENUM_MAP"),
  values: z.record(z.string(), jsonValueSchema),
  default: jsonValueSchema.optional(),
});
const mappingSchema = z.union([
  directMappingSchema,
  concatMappingSchema,
  enumMappingSchema,
]);
export const transformationDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    contentType: z.literal("application/json"),
    mappings: z.array(mappingSchema).min(1).max(100),
  })
  .strict()
  .superRefine((definition, context) => {
    const targets = new Set<string>();
    definition.mappings.forEach((mapping, index) => {
      if (
        [...targets].some(
          (target) =>
            target === mapping.target ||
            target.startsWith(`${mapping.target}.`) ||
            mapping.target.startsWith(`${target}.`),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "target"],
          message: "Target paths must be unique.",
        });
      targets.add(mapping.target);
    });
  });
export type TransformationDefinition = z.infer<
  typeof transformationDefinitionSchema
>;

const externalKey = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9_-]*$/);
const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().positive(),
    initialDelaySeconds: z.number().positive(),
    multiplier: z.number().positive(),
    maxDelaySeconds: z.number().positive(),
    jitter: z.literal("FULL_UPPER_HALF"),
  })
  .strict();
const rateLimitPolicySchema = z
  .object({
    requestsPerInterval: z.number().int().positive(),
    intervalSeconds: z.number().positive(),
    burstCapacity: z.number().int().positive(),
    safetyFactor: z.number().positive().max(1),
  })
  .strict();
const circuitPolicySchema = z
  .object({
    failureThreshold: z.number().int().positive(),
    cooldownSeconds: z.number().positive(),
    probeLeaseSeconds: z.number().positive(),
  })
  .strict();
const secretInputSchema = z
  .object({
    alias: externalKey,
    value: z
      .string()
      .min(1)
      .max(16 * 1024),
  })
  .strict();
const apiKeyAuthenticationSchema = z
  .object({
    type: z.literal("api_key"),
    headerName: z
      .string()
      .regex(/^X-[A-Za-z0-9-]{1,64}$/)
      .default("X-API-Key"),
    idempotencyHeader: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .default("Idempotency-Key"),
    credential: secretInputSchema,
  })
  .strict();
const oauthAuthenticationSchema = z
  .object({
    type: z.literal("oauth_client_credentials"),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1).max(256),
    scopes: z.array(z.string().min(1).max(128)).max(20).default([]),
    authenticationStyle: z.enum(["basic", "body"]).default("basic"),
    credential: secretInputSchema,
  })
  .strict();
export const destinationAuthenticationSchema = z.discriminatedUnion("type", [
  apiKeyAuthenticationSchema,
  oauthAuthenticationSchema,
]);
const destinationBaseSchema = z
  .object({
    name: z.string().min(1).max(128),
    externalKey,
    baseUrl: z.string().url(),
    path: z.string().regex(/^\/[A-Za-z0-9_./-]*$/),
    enabled: z.boolean().default(true),
    method: z.literal("POST").default("POST"),
    authentication: destinationAuthenticationSchema,
    timeoutMs: z.number().int().min(100).max(30_000),
    retryPolicy: retryPolicySchema,
    rateLimitPolicy: rateLimitPolicySchema,
    circuitBreakerPolicy: circuitPolicySchema,
    transformationId: identifier("trf"),
    activeTransformationVersion: z.number().int().positive(),
    sensitiveResponseJsonPaths: z.array(jsonPath).max(50).default([]),
  })
  .strict();
export const createPartnerRequestSchema = z
  .object({
    name: z.string().min(1).max(128),
    externalKey,
    description: z.string().max(1024).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const updatePartnerRequestSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    description: z.string().max(1024).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Update requires at least one field.",
  );
export const createDestinationRequestSchema = destinationBaseSchema;
export const updateDestinationRequestSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    baseUrl: z.string().url().optional(),
    path: z
      .string()
      .regex(/^\/[A-Za-z0-9_./-]*$/)
      .optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    retryPolicy: retryPolicySchema.optional(),
    rateLimitPolicy: rateLimitPolicySchema.optional(),
    circuitBreakerPolicy: circuitPolicySchema.optional(),
    transformationId: identifier("trf").optional(),
    activeTransformationVersion: z.number().int().positive().optional(),
    sensitiveResponseJsonPaths: z.array(jsonPath).max(50).optional(),
    authentication: destinationAuthenticationSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Update requires at least one field.",
  );
export const createTransformationRequestSchema = z
  .object({
    externalKey,
    definition: transformationDefinitionSchema,
    sampleEvent: jsonObjectSchema.optional(),
  })
  .strict();
export const createTransformationVersionRequestSchema = z
  .object({
    definition: transformationDefinitionSchema,
    sampleEvent: jsonObjectSchema.optional(),
  })
  .strict();
export const validateTransformationRequestSchema = z
  .object({
    definition: transformationDefinitionSchema,
    sampleEvent: jsonObjectSchema,
  })
  .strict();
export const createSubscriptionRequestSchema = z
  .object({
    externalKey,
    destinationId: identifier("dst"),
    eventType: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreatePartnerRequest = z.infer<typeof createPartnerRequestSchema>;
export type CreateDestinationRequest = z.infer<
  typeof createDestinationRequestSchema
>;

export const paginationCursorPayloadSchema = z
  .object({
    tenantId: identifier("tenant"),
    endpointFingerprint: z.string().min(16).max(128),
    lastEvaluatedKey: jsonObjectSchema,
    expiresAt: isoInstant,
  })
  .strict();
export type PaginationCursorPayload = z.infer<
  typeof paginationCursorPayloadSchema
>;

export const apiMetaSchema = z
  .object({
    service: z.literal("partner-integration-reliability-hub"),
    apiVersion: z.literal("v1"),
    contractVersion: z.literal(1),
    mode: z.literal("skeleton"),
  })
  .strict();
