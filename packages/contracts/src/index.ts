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

const mappingSchema = z
  .object({
    target: z.string().regex(/^\$\.[A-Za-z0-9_.]+$/),
    source: z
      .string()
      .regex(/^\$\.[A-Za-z0-9_.]+$/)
      .optional(),
    literal: jsonValueSchema.optional(),
    transform: z
      .enum([
        "UPPERCASE",
        "LOWERCASE",
        "UPPER_SNAKE",
        "ISO_DATE",
        "CONCAT",
        "ENUM_MAP",
      ])
      .optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .refine(
    (mapping) => mapping.source !== undefined || mapping.literal !== undefined,
    "Mapping requires source or literal.",
  );
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
      if (targets.has(mapping.target))
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
