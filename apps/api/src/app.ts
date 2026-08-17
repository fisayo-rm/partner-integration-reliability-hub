import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  apiMetaSchema,
  canonicalEventRequestSchema,
  createDestinationRequestSchema,
  createPartnerRequestSchema,
  createSubscriptionRequestSchema,
  createTransformationRequestSchema,
  createTransformationVersionRequestSchema,
  updateDestinationRequestSchema,
  updatePartnerRequestSchema,
  validateTransformationRequestSchema,
  eventAcceptanceResponseSchema,
  eventStatusResponseSchema,
} from "@pirh/contracts";
import {
  ControlPlaneService,
  EventIngestionService,
  type ControlPlaneRepository,
  type CoreRepository,
} from "@pirh/application";
import {
  AuthenticationError,
  requireRole,
  type ConsoleAuthenticator,
  type ProducerAuthenticator,
} from "@pirh/auth";
import type {
  Destination,
  Partner,
  TenantContext,
  TransformationVersion,
} from "@pirh/domain";
import {
  consoleAuthenticationHook,
  producerAuthenticationHook,
} from "./auth.js";

export interface HealthProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}
export type HealthProbe = () => Promise<HealthProbeResult>;
export interface ApiDependencies {
  readonly requiredConfiguration: HealthProbe;
  readonly dynamoDb: HealthProbe;
  readonly elasticMq: HealthProbe;
  readonly controlPlane?: {
    readonly service: ControlPlaneService;
    readonly repository: ControlPlaneRepository & CoreRepository;
    readonly consoleAuthenticator: ConsoleAuthenticator;
    readonly cursorSecret: string;
  };
  readonly eventIngestion?: {
    readonly service: EventIngestionService;
    readonly repository: CoreRepository;
    readonly producerAuthenticator: ProducerAuthenticator;
  };
  readonly requestId?: () => string;
}

function cursor(secret: string, value: string): string {
  return `${Buffer.from(value, "utf8").toString("base64url")}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
}
function decodeCursor(secret: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) throw new Error("VALIDATION_ERROR");
  const raw = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", secret).update(raw).digest("base64url");
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  )
    throw new Error("VALIDATION_ERROR");
  return raw;
}
function page(request: { readonly query: unknown }, secret: string) {
  const input = (request.query ?? {}) as { limit?: unknown; cursor?: unknown };
  const limit = input.limit === undefined ? 25 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("VALIDATION_ERROR");
  const value = decodeCursor(secret, input.cursor);
  return value === undefined ? { limit } : { limit, cursor: value };
}
function publicDestination(value: Destination) {
  const rest = { ...value } as Record<string, unknown>;
  delete rest.secretReferences;
  const authConfiguration = value.authConfiguration;
  delete rest.authConfiguration;
  const alias = value.secretReferences[0]?.name;
  return {
    ...rest,
    authConfiguration,
    credential: { alias, configured: alias !== undefined },
  };
}
function error(
  reply: { code(code: number): { send(value: unknown): unknown } },
  code: number,
  name: string,
  message: string,
) {
  return reply.code(code).send({ error: { code: name, message } });
}

export async function buildApi(
  dependencies: ApiDependencies,
): Promise<FastifyInstance> {
  const app = Fastify(
    dependencies.requestId === undefined
      ? { logger: false }
      : {
          logger: false,
          genReqId: () =>
            dependencies.requestId?.() ?? "req_00000000000000000000000000",
        },
  );
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      request.rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch (caught) {
        done(caught as Error);
      }
    },
  );
  app.setErrorHandler((caught, request, reply) => {
    const correlationId = `cor_${request.id.slice(4)}`;
    if (caught instanceof AuthenticationError)
      return reply.code(caught.statusCode).send({
        error: {
          code: caught.statusCode === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
          message: "Authentication failed.",
          requestId: request.id,
          correlationId,
        },
      });
    if ((caught as { statusCode?: number }).statusCode === 413)
      return reply.code(413).send({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "The request body exceeds 128 KiB.",
          requestId: request.id,
          correlationId,
        },
      });
    return reply.code(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "The request is invalid.",
        requestId: request.id,
        correlationId,
      },
    });
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Partner Integration Reliability Hub API",
        version: "0.1.0",
      },
      servers: [{ url: "/api/v1" }],
    },
  });
  app.get(
    "/health/live",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string" } },
          },
        },
      },
    },
    async () => ({ status: "ok" }),
  );
  app.get("/health/ready", async (_request, reply) => {
    const probes = await Promise.all([
      dependencies.requiredConfiguration(),
      dependencies.dynamoDb(),
      dependencies.elasticMq(),
    ]);
    if (probes.every((probe) => probe.ok))
      return { status: "ready", dependencies: probes };
    return reply.code(503).send({ status: "not_ready", dependencies: probes });
  });
  app.get(
    "/api/v1/meta",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["service", "apiVersion", "contractVersion", "mode"],
            properties: {
              service: { const: "partner-integration-reliability-hub" },
              apiVersion: { const: "v1" },
              contractVersion: { const: 1 },
              mode: { const: "skeleton" },
            },
          },
        },
      },
    },
    async () =>
      apiMetaSchema.parse({
        service: "partner-integration-reliability-hub",
        apiVersion: "v1",
        contractVersion: 1,
        mode: "skeleton",
      }),
  );
  app.get("/openapi.json", async () => app.swagger());
  const ingestion = dependencies.eventIngestion;
  if (ingestion !== undefined) {
    const producerSubmit = producerAuthenticationHook(
      ingestion.producerAuthenticator,
      "events:submit",
    );
    const producerRead = producerAuthenticationHook(
      ingestion.producerAuthenticator,
      "events:read",
    );
    app.post(
      "/api/v1/events",
      {
        preHandler: producerSubmit,
        bodyLimit: 128 * 1024,
      },
      async (request, reply) => {
        const idempotencyKey = request.headers["idempotency-key"];
        if (
          typeof idempotencyKey !== "string" ||
          idempotencyKey.length === 0 ||
          idempotencyKey.length > 256
        )
          return reply.code(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: "Idempotency-Key is required.",
              requestId: request.id,
              correlationId: `cor_${request.id.slice(4)}`,
            },
          });
        try {
          const parsed = canonicalEventRequestSchema.parse(request.body);
          const accepted = await ingestion.service.accept(
            request.tenantContext as TenantContext,
            {
              eventType: parsed.eventType,
              occurredAt: parsed.occurredAt,
              subject: parsed.subject,
              data: parsed.data as never,
              metadata: parsed.metadata as never,
              idempotencyKey,
            },
          );
          const body = eventAcceptanceResponseSchema.parse({
            eventId: accepted.event.eventId,
            correlationId: accepted.event.correlationId,
            status: "accepted",
            previouslyAccepted: accepted.previouslyAccepted,
            acceptedAt: accepted.event.acceptedAt,
          });
          console.log(
            JSON.stringify({
              service: "api",
              event: "event.accepted",
              eventId: body.eventId,
              correlationId: body.correlationId,
              duplicate: body.previouslyAccepted,
            }),
          );
          return reply
            .code(accepted.previouslyAccepted ? 200 : 202)
            .header("x-correlation-id", body.correlationId)
            .send(body);
        } catch (caught) {
          if (
            caught instanceof Error &&
            caught.message === "IDEMPOTENCY_KEY_REUSED"
          )
            return reply.code(409).send({
              error: {
                code: "IDEMPOTENCY_KEY_REUSED",
                message:
                  "The idempotency key was used with a different request.",
                requestId: request.id,
                correlationId: `cor_${request.id.slice(4)}`,
              },
            });
          if (
            caught instanceof Error &&
            caught.message === "UNSUPPORTED_EVENT_TYPE"
          )
            return reply.code(400).send({
              error: {
                code: "UNSUPPORTED_EVENT_TYPE",
                message: "The event type is not supported.",
                requestId: request.id,
                correlationId: `cor_${request.id.slice(4)}`,
              },
            });
          throw caught;
        }
      },
    );
    app.get(
      "/api/v1/events/:eventId",
      { preHandler: producerRead },
      async (request, reply) => {
        const event = await ingestion.repository.getEvent(
          request.tenantContext as TenantContext,
          (request.params as { eventId: never }).eventId,
        );
        if (event === undefined)
          return reply.code(404).send({
            error: {
              code: "NOT_FOUND",
              message: "Event not found.",
              requestId: request.id,
              correlationId: `cor_${request.id.slice(4)}`,
            },
          });
        const body = eventStatusResponseSchema.parse({
          eventId: event.eventId,
          correlationId: event.correlationId,
          eventType: event.eventType,
          acceptedAt: event.acceptedAt,
          status: event.status,
        });
        return reply.header("x-correlation-id", body.correlationId).send(body);
      },
    );
  }
  const control = dependencies.controlPlane;
  if (control !== undefined) {
    const authenticated = consoleAuthenticationHook(
      control.consoleAuthenticator,
    );
    const admin = async (request: { tenantContext?: TenantContext }) =>
      requireRole(request.tenantContext as TenantContext, "admin");
    const context = (request: { tenantContext?: TenantContext }) =>
      request.tenantContext as TenantContext;
    const mapError = async (
      handler: () => Promise<unknown>,
      reply: { code(code: number): { send(value: unknown): unknown } },
    ) => {
      try {
        return await handler();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "INTERNAL";
        if (message === "NOT_FOUND")
          return error(reply, 404, message, "Resource not found.");
        if (message === "PRECONDITION_FAILED")
          return error(reply, 412, message, "Resource version does not match.");
        if (message === "CONFLICT")
          return error(
            reply,
            409,
            message,
            "The resource conflicts with existing configuration.",
          );
        if (message.endsWith("_LIMIT"))
          return error(
            reply,
            409,
            message,
            "Demo configuration limit reached.",
          );
        return error(reply, 400, "VALIDATION_ERROR", "The request is invalid.");
      }
    };
    app.get(
      "/api/v1/partners",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(async () => {
          const result = await control.repository.listPartners(
            context(request),
            page(request, control.cursorSecret),
          );
          return {
            items: result.items,
            ...(result.cursor === undefined
              ? {}
              : { cursor: cursor(control.cursorSecret, result.cursor) }),
          };
        }, reply),
    );
    app.post(
      "/api/v1/partners",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(
          async () =>
            control.service.createPartner(
              context(request),
              createPartnerRequestSchema.parse(request.body) as never,
            ),
          reply,
        ),
    );
    app.get(
      "/api/v1/partners/:partnerId",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(async () => {
          const partner = await control.repository.getPartner(
            context(request),
            (request.params as { partnerId: Partner["partnerId"] }).partnerId,
          );
          if (partner === undefined) throw new Error("NOT_FOUND");
          return partner;
        }, reply),
    );
    app.patch(
      "/api/v1/partners/:partnerId",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(async () => {
          const partner = await control.repository.getPartner(
            context(request),
            (request.params as { partnerId: Partner["partnerId"] }).partnerId,
          );
          if (partner === undefined) throw new Error("NOT_FOUND");
          const match = request.headers["if-match"];
          if (typeof match !== "string" || !/^"[1-9][0-9]*"$/.test(match))
            throw new Error("PRECONDITION_FAILED");
          return control.service.updatePartner(
            context(request),
            partner,
            Number(match.slice(1, -1)),
            updatePartnerRequestSchema.parse(request.body) as never,
          );
        }, reply),
    );
    app.post(
      "/api/v1/partners/:partnerId/destinations",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(async () => {
          const input = createDestinationRequestSchema.parse(request.body);
          const { authentication, ...configuration } = input;
          const partnerId = (
            request.params as { partnerId: Destination["partnerId"] }
          ).partnerId;
          return publicDestination(
            await control.service.createDestination(context(request), {
              ...configuration,
              partnerId,
              authType: authentication.type,
              authConfiguration:
                authentication.type === "api_key"
                  ? {
                      headerName: authentication.headerName,
                      idempotencyHeader: authentication.idempotencyHeader,
                    }
                  : {
                      tokenUrl: authentication.tokenUrl,
                      clientId: authentication.clientId,
                      scopes: authentication.scopes,
                      authenticationStyle: authentication.authenticationStyle,
                    },
              credential: authentication.credential,
            } as never),
          );
        }, reply),
    );
    app.get(
      "/api/v1/destinations/:destinationId",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(async () => {
          const destination = await control.repository.getDestination(
            context(request),
            (request.params as { destinationId: Destination["destinationId"] })
              .destinationId,
          );
          if (destination === undefined) throw new Error("NOT_FOUND");
          return publicDestination(destination);
        }, reply),
    );
    app.patch(
      "/api/v1/destinations/:destinationId",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(async () => {
          const destination = await control.repository.getDestination(
            context(request),
            (request.params as { destinationId: Destination["destinationId"] })
              .destinationId,
          );
          if (destination === undefined) throw new Error("NOT_FOUND");
          const match = request.headers["if-match"];
          if (typeof match !== "string" || !/^"[1-9][0-9]*"$/.test(match))
            throw new Error("PRECONDITION_FAILED");
          const input = updateDestinationRequestSchema.parse(request.body);
          const { authentication, ...configuration } = input;
          const changed = {
            ...configuration,
            ...(authentication === undefined
              ? {}
              : {
                  authType: authentication.type,
                  authConfiguration:
                    authentication.type === "api_key"
                      ? {
                          headerName: authentication.headerName,
                          idempotencyHeader: authentication.idempotencyHeader,
                        }
                      : {
                          tokenUrl: authentication.tokenUrl,
                          clientId: authentication.clientId,
                          scopes: authentication.scopes,
                          authenticationStyle:
                            authentication.authenticationStyle,
                        },
                  credential: authentication.credential,
                }),
          };
          return publicDestination(
            await control.service.updateDestination(
              context(request),
              destination,
              Number(match.slice(1, -1)),
              changed as never,
            ),
          );
        }, reply),
    );
    app.post(
      "/api/v1/transformations",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(
          async () =>
            control.service.createTransformation(
              context(request),
              createTransformationRequestSchema.parse(request.body) as never,
            ),
          reply,
        ),
    );
    app.get(
      "/api/v1/transformations/:transformationId/versions",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(async () => {
          const result = await control.repository.listTransformationVersions(
            context(request),
            (
              request.params as {
                transformationId: TransformationVersion["transformationId"];
              }
            ).transformationId,
            page(request, control.cursorSecret),
          );
          return {
            items: result.items,
            ...(result.cursor === undefined
              ? {}
              : { cursor: cursor(control.cursorSecret, result.cursor) }),
          };
        }, reply),
    );
    app.post(
      "/api/v1/transformations/:transformationId/versions",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(async () => {
          const id = (
            request.params as {
              transformationId: TransformationVersion["transformationId"];
            }
          ).transformationId;
          const versions = await control.repository.listTransformationVersions(
            context(request),
            id,
            { limit: 100 },
          );
          const existing = versions.items.at(-1);
          if (existing === undefined) throw new Error("NOT_FOUND");
          return control.service.createTransformationVersion(
            context(request),
            existing,
            createTransformationVersionRequestSchema.parse(
              request.body,
            ) as never,
          );
        }, reply),
    );
    app.post(
      "/api/v1/transformations/validate",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(
          async () =>
            control.service.validateTransformation(
              validateTransformationRequestSchema.parse(request.body) as never,
            ),
          reply,
        ),
    );
    app.get(
      "/api/v1/subscriptions",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(async () => {
          const result = await control.repository.listControlSubscriptions(
            context(request),
            page(request, control.cursorSecret),
          );
          return {
            items: result.items,
            ...(result.cursor === undefined
              ? {}
              : { cursor: cursor(control.cursorSecret, result.cursor) }),
          };
        }, reply),
    );
    app.post(
      "/api/v1/subscriptions",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(
          async () =>
            control.service.createSubscription(
              context(request),
              createSubscriptionRequestSchema.parse(request.body) as never,
            ),
          reply,
        ),
    );
    app.delete(
      "/api/v1/subscriptions/:subscriptionId",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(async () => {
          await control.service.deleteSubscription(
            context(request),
            (request.params as { subscriptionId: never }).subscriptionId,
          );
          return reply.code(204).send();
        }, reply),
    );
  }
  return app;
}
