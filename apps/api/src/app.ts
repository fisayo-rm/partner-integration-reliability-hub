import swagger from "@fastify/swagger";
import cors from "@fastify/cors";
import Fastify, {
  type FastifyInstance,
  type preHandlerHookHandler,
} from "fastify";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  replayRequestSchema,
  replayResponseSchema,
  eventSearchQuerySchema,
  deliverySearchQuerySchema,
  auditSearchQuerySchema,
  rollupQuerySchema,
  sessionResponseSchema,
  paginationCursorPayloadSchema,
  eventAcceptanceResponseSchema,
  eventStatusResponseSchema,
} from "@pirh/contracts";
import {
  ControlPlaneService,
  EventIngestionService,
  ReplayService,
  redactedJson,
  type OperationsRepository,
  type ControlPlaneRepository,
  type CoreRepository,
} from "@pirh/application";
import {
  ConfigurationPortabilityError,
  ConfigurationPortabilityService,
} from "@pirh/config-portability";
import {
  addTraceAttributes,
  withSpan,
  type RuntimeLogger,
} from "@pirh/observability";
import {
  AuthenticationError,
  requireRole,
  type ConsoleAuthenticator,
  type ProducerAuthenticator,
} from "@pirh/auth";
import { replayEligibility } from "@pirh/domain";
import type {
  CircuitRuntimeState,
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
  readonly operations?: {
    readonly service: ReplayService;
    readonly repository: OperationsRepository;
    readonly consoleAuthenticator: ConsoleAuthenticator;
    readonly cursorSecret: string;
    readonly now?: () => Date;
  };
  readonly portability?: {
    readonly service: ConfigurationPortabilityService;
  };
  readonly requestId?: () => string;
  readonly logger?: RuntimeLogger;
  readonly telemetry?: import("@pirh/application").Telemetry;
  readonly consoleOrigins?: readonly string[];
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
function operationPage(input: {
  readonly query: Record<string, unknown>;
  readonly secret: string;
  readonly tenantId: TenantContext["tenantId"];
  readonly endpoint: string;
  readonly now: Date;
}) {
  const limit = Number(input.query.limit ?? 25);
  const from =
    typeof input.query.from === "string"
      ? input.query.from
      : new Date(input.now.getTime() - 24 * 3_600_000).toISOString();
  const to =
    typeof input.query.to === "string"
      ? input.query.to
      : input.now.toISOString();
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(to) < Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 30 * 86_400_000
  )
    throw new Error("VALIDATION_ERROR");
  const normalized = JSON.stringify(
    Object.fromEntries(
      Object.entries({ ...input.query, from, to, cursor: undefined }).sort(
        ([left], [right]) => left.localeCompare(right),
      ),
    ),
  );
  const endpointFingerprint = createHash("sha256")
    .update(`${input.endpoint}\n${normalized}`)
    .digest("hex");
  const supplied = input.query.cursor;
  if (supplied === undefined) return { limit, from, to, endpointFingerprint };
  if (typeof supplied !== "string") throw new Error("INVALID_CURSOR");
  let raw: string | undefined;
  try {
    raw = decodeCursor(input.secret, supplied);
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (raw === undefined) throw new Error("INVALID_CURSOR");
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  const parsed = paginationCursorPayloadSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.tenantId !== input.tenantId ||
    parsed.data.endpointFingerprint !== endpointFingerprint ||
    Date.parse(parsed.data.expiresAt) <= input.now.getTime()
  )
    throw new Error("INVALID_CURSOR");
  return {
    limit,
    from,
    to,
    endpointFingerprint,
    cursor: JSON.stringify(parsed.data.lastEvaluatedKey),
  };
}
function operationCursor(input: {
  readonly secret: string;
  readonly tenantId: TenantContext["tenantId"];
  readonly endpointFingerprint: string;
  readonly cursor: string;
  readonly now: Date;
}): string {
  const value = JSON.stringify({
    tenantId: input.tenantId,
    endpointFingerprint: input.endpointFingerprint,
    lastEvaluatedKey: JSON.parse(input.cursor),
    expiresAt: new Date(input.now.getTime() + 15 * 60_000).toISOString(),
  });
  return cursor(input.secret, value);
}
function publicDestination(value: Destination, circuit?: CircuitRuntimeState) {
  const rest = { ...value } as Record<string, unknown>;
  delete rest.secretReferences;
  const authConfiguration = value.authConfiguration;
  delete rest.authConfiguration;
  const alias = value.secretReferences[0]?.name;
  return {
    ...rest,
    authConfiguration,
    credential: { alias, configured: alias !== undefined },
    ...(circuit === undefined ? {} : { circuit }),
  };
}
function error(
  reply: { code(code: number): { send(value: unknown): unknown } },
  code: number,
  name: string,
  message: string,
  request?: { readonly id: string },
) {
  return reply.code(code).send({
    error: {
      code: name,
      message,
      ...(request === undefined
        ? {}
        : {
            requestId: request.id,
            correlationId: `cor_${request.id.slice(4)}`,
          }),
    },
  });
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
  await app.register(cors, {
    origin(origin, callback) {
      if (
        origin === undefined ||
        dependencies.consoleOrigins === undefined ||
        dependencies.consoleOrigins.includes(origin)
      )
        callback(null, true);
      else callback(null, false);
    },
    credentials: false,
  });
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
    if (caught instanceof AuthenticationError) {
      dependencies.logger?.warn("Authentication failed", {
        event: "authentication.failed",
        route: request.routeOptions.url,
        requestId: request.id,
        correlationId,
        statusCode: caught.statusCode,
      });
      return reply.code(caught.statusCode).send({
        error: {
          code: caught.statusCode === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
          message: "Authentication failed.",
          requestId: request.id,
          correlationId,
        },
      });
    }
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
    const checks = probes.map((probe) => ({
      name: probe.name,
      status: probe.ok ? "up" : "down",
    }));
    if (probes.every((probe) => probe.ok)) return { status: "ready", checks };
    dependencies.logger?.warn("Readiness probe failed", {
      event: "health.not_ready",
      failedChecks: probes
        .filter((probe) => !probe.ok)
        .map((probe) => probe.name),
    });
    return reply.code(503).send({ status: "not_ready", checks });
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
          const accepted = await withSpan(
            "api.events.submit",
            { route: "events.submit" },
            () =>
              ingestion.service.accept(request.tenantContext as TenantContext, {
                eventType: parsed.eventType,
                occurredAt: parsed.occurredAt,
                subject: parsed.subject,
                data: parsed.data as never,
                metadata: parsed.metadata as never,
                idempotencyKey,
              }),
          );
          const body = eventAcceptanceResponseSchema.parse({
            eventId: accepted.event.eventId,
            correlationId: accepted.event.correlationId,
            status: "accepted",
            previouslyAccepted: accepted.previouslyAccepted,
            acceptedAt: accepted.event.acceptedAt,
          });
          addTraceAttributes({
            correlationId: body.correlationId,
            eventId: body.eventId,
            tenantId: (request.tenantContext as TenantContext).tenantId,
          });
          dependencies.telemetry?.count("api.requests", 1, {
            route: "events.submit",
            statusCode: accepted.previouslyAccepted ? 200 : 202,
          });
          dependencies.logger?.info("Event accepted", {
            event: "event.accepted",
            eventId: body.eventId,
            correlationId: body.correlationId,
            duplicate: body.previouslyAccepted,
            tenantId: (request.tenantContext as TenantContext).tenantId,
          });
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
    if (dependencies.operations === undefined)
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
          return reply
            .header("x-correlation-id", body.correlationId)
            .send(body);
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
      request?: { readonly id: string },
    ) => {
      try {
        return await handler();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "INTERNAL";
        if (message === "NOT_FOUND")
          return error(reply, 404, message, "Resource not found.", request);
        if (message === "PRECONDITION_FAILED")
          return error(
            reply,
            412,
            message,
            "Resource version does not match.",
            request,
          );
        if (message === "CONFLICT")
          return error(
            reply,
            409,
            message,
            "The resource conflicts with existing configuration.",
            request,
          );
        if (message.endsWith("_LIMIT"))
          return error(
            reply,
            409,
            message,
            "Demo configuration limit reached.",
            request,
          );
        if (caught instanceof ConfigurationPortabilityError)
          return error(
            reply,
            caught.code === "PLAN_DRIFT" ? 409 : 400,
            caught.code,
            "Configuration portability request was rejected.",
            request,
          );
        return error(
          reply,
          400,
          "VALIDATION_ERROR",
          "The request is invalid.",
          request,
        );
      }
    };
    app.get(
      "/api/v1/partners",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(
          async () => {
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
          },
          reply,
          request,
        ),
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
    const portability = dependencies.portability;
    if (portability !== undefined) {
      app.post(
        "/api/v1/configuration/exports",
        { preHandler: [authenticated, admin] },
        async (request, reply) =>
          mapError(
            async () =>
              portability.service.export(
                context(request),
                (request.body as { readonly tenant?: unknown } | undefined)
                  ?.tenant as string | undefined,
              ),
            reply,
            request,
          ),
      );
      app.post(
        "/api/v1/configuration/imports/validate",
        { preHandler: [authenticated, admin] },
        async (request, reply) =>
          mapError(
            async () => {
              const bundle = await portability.service.validate(
                context(request),
                (request.body as { readonly bundle?: unknown } | undefined)
                  ?.bundle,
              );
              return {
                bundle,
                digest: (
                  await portability.service.plan(context(request), bundle)
                ).digest,
              };
            },
            reply,
            request,
          ),
      );
      app.post(
        "/api/v1/configuration/imports/plan",
        { preHandler: [authenticated, admin] },
        async (request, reply) =>
          mapError(
            async () =>
              portability.service.plan(
                context(request),
                (request.body as { readonly bundle?: unknown } | undefined)
                  ?.bundle,
              ),
            reply,
            request,
          ),
      );
      app.post(
        "/api/v1/configuration/imports/apply",
        { preHandler: [authenticated, admin] },
        async (request, reply) =>
          mapError(
            async () => {
              const body = request.body as
                | { readonly bundle?: unknown; readonly receipt?: unknown }
                | undefined;
              if (typeof body?.receipt !== "string")
                throw new Error("VALIDATION_ERROR");
              return portability.service.apply(
                context(request),
                body.bundle,
                body.receipt,
              );
            },
            reply,
            request,
          ),
      );
    }
    app.get(
      "/api/v1/partners/:partnerId",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(
          async () => {
            const partner = await control.repository.getPartner(
              context(request),
              (request.params as { partnerId: Partner["partnerId"] }).partnerId,
            );
            if (partner === undefined) throw new Error("NOT_FOUND");
            return partner;
          },
          reply,
          request,
        ),
    );
    app.get(
      "/api/v1/destinations",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(
          async () => {
            const query = (request.query ?? {}) as { partnerId?: unknown };
            if (
              query.partnerId !== undefined &&
              (typeof query.partnerId !== "string" ||
                query.partnerId.length === 0)
            )
              throw new Error("VALIDATION_ERROR");
            const result = await control.repository.listDestinations(
              context(request),
              {
                ...page(request, control.cursorSecret),
                ...(query.partnerId === undefined
                  ? {}
                  : { partnerId: query.partnerId as Destination["partnerId"] }),
              },
            );
            const items = await Promise.all(
              result.items.map(async (destination) =>
                publicDestination(
                  destination,
                  await control.repository.getCircuitState(
                    context(request),
                    destination.destinationId,
                  ),
                ),
              ),
            );
            return {
              items,
              ...(result.cursor === undefined
                ? {}
                : { cursor: cursor(control.cursorSecret, result.cursor) }),
            };
          },
          reply,
          request,
        ),
    );
    app.patch(
      "/api/v1/partners/:partnerId",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(
          async () => {
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
          },
          reply,
          request,
        ),
    );
    app.post(
      "/api/v1/partners/:partnerId/destinations",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(
          async () => {
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
          },
          reply,
          request,
        ),
    );
    app.get(
      "/api/v1/destinations/:destinationId",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(
          async () => {
            const destination = await control.repository.getDestination(
              context(request),
              (
                request.params as {
                  destinationId: Destination["destinationId"];
                }
              ).destinationId,
            );
            if (destination === undefined) throw new Error("NOT_FOUND");
            return publicDestination(destination);
          },
          reply,
          request,
        ),
    );
    app.patch(
      "/api/v1/destinations/:destinationId",
      { preHandler: [authenticated, admin] },
      async (request, reply) =>
        mapError(
          async () => {
            const destination = await control.repository.getDestination(
              context(request),
              (
                request.params as {
                  destinationId: Destination["destinationId"];
                }
              ).destinationId,
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
          },
          reply,
          request,
        ),
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
    app.get(
      "/api/v1/transformations",
      { preHandler: authenticated },
      async (request, reply) =>
        mapError(async () => {
          const result = await control.repository.listTransformations(
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
  const operations = dependencies.operations;
  if (operations !== undefined) {
    const authenticated = consoleAuthenticationHook(
      operations.consoleAuthenticator,
    );
    const eventRead: preHandlerHookHandler = async (request) => {
      const authorization = request.headers.authorization;
      if (
        typeof authorization === "string" &&
        authorization.startsWith("Bearer ")
      ) {
        request.tenantContext =
          await operations.consoleAuthenticator.authenticate(
            authorization.slice("Bearer ".length),
            request.id,
            `cor_${request.id.slice(4)}` as TenantContext["correlationId"],
          );
        return;
      }
      const producer = dependencies.eventIngestion?.producerAuthenticator;
      const clientId = request.headers["x-client-id"];
      const timestamp = request.headers["x-timestamp"];
      const nonce = request.headers["x-nonce"];
      const signature = request.headers["x-signature"];
      if (
        producer !== undefined &&
        typeof clientId === "string" &&
        typeof timestamp === "string" &&
        typeof nonce === "string" &&
        typeof signature === "string"
      ) {
        request.tenantContext = await producer.authenticate({
          method: request.method,
          path: request.url.split("?", 1)[0] ?? request.url,
          rawBody: request.rawBody ?? Buffer.alloc(0),
          clientId: clientId as never,
          timestamp,
          nonce,
          signature,
          requiredScope: "events:read",
          requestId: request.id,
          correlationId:
            `cor_${request.id.slice(4)}` as TenantContext["correlationId"],
        });
        return;
      }
      throw new AuthenticationError();
    };
    const operationContext = (request: { tenantContext?: TenantContext }) =>
      request.tenantContext as TenantContext;
    const now = () => operations.now?.() ?? new Date();
    const mapOperation = async (
      handler: () => Promise<unknown>,
      reply: { code(code: number): { send(value: unknown): unknown } },
      request: { readonly id: string },
    ) => {
      try {
        return await handler();
      } catch (caught) {
        const code =
          caught instanceof Error ? caught.message : "VALIDATION_ERROR";
        if (code === "NOT_FOUND")
          return error(reply, 404, code, "Resource not found.", request);
        if (code === "FORBIDDEN")
          return error(reply, 403, code, "Permission denied.", request);
        if (code === "IDEMPOTENCY_KEY_REUSED")
          return error(
            reply,
            409,
            code,
            "The idempotency key was used with a different request.",
            request,
          );
        if (code.startsWith("REPLAY_"))
          return error(
            reply,
            409,
            code,
            "Delivery cannot be replayed.",
            request,
          );
        if (code === "INVALID_CURSOR")
          return error(
            reply,
            400,
            code,
            "The pagination cursor is invalid.",
            request,
          );
        return error(
          reply,
          400,
          "VALIDATION_ERROR",
          "The request is invalid.",
          request,
        );
      }
    };
    const operationInput = (
      request: { readonly query: unknown },
      endpoint: string,
      parsed: Record<string, unknown>,
    ) => {
      const current = operationContext(
        request as { tenantContext?: TenantContext },
      );
      return operationPage({
        query: parsed,
        secret: operations.cursorSecret,
        tenantId: current.tenantId,
        endpoint,
        now: now(),
      });
    };
    const responseCursor = (
      context: TenantContext,
      endpointFingerprint: string,
      value: string | undefined,
    ) =>
      value === undefined
        ? undefined
        : operationCursor({
            secret: operations.cursorSecret,
            tenantId: context.tenantId,
            endpointFingerprint,
            cursor: value,
            now: now(),
          });
    app.get(
      "/api/v1/session",
      { preHandler: authenticated },
      async (request) => {
        const current = operationContext(request);
        if (current.role === undefined) throw new AuthenticationError(403);
        return sessionResponseSchema.parse({
          actorId: current.actorId,
          tenantId: current.tenantId,
          role: current.role,
        });
      },
    );
    app.get(
      "/api/v1/events",
      { preHandler: authenticated },
      async (request, reply) =>
        mapOperation(
          async () => {
            const parsed = eventSearchQuerySchema.parse(
              request.query,
            ) as Record<string, unknown>;
            const page = operationInput(request, "events", parsed);
            const exact = [
              parsed.eventId,
              parsed.correlationId,
              parsed.idempotencyKey,
            ].filter(Boolean);
            if (exact.length > 1) throw new Error("VALIDATION_ERROR");
            const result = await operations.repository.searchEvents(
              operationContext(request),
              {
                ...page,
                eventId: parsed.eventId as never,
                correlationId: parsed.correlationId as never,
                idempotencyKeyHash:
                  typeof parsed.idempotencyKey === "string"
                    ? createHash("sha256")
                        .update(parsed.idempotencyKey)
                        .digest("hex")
                    : undefined,
                eventType: parsed.eventType as string | undefined,
                status: parsed.status as string | undefined,
              },
            );
            const cursor = responseCursor(
              operationContext(request),
              page.endpointFingerprint,
              result.cursor,
            );
            return {
              items: result.items,
              ...(cursor === undefined ? {} : { cursor }),
            };
          },
          reply,
          request,
        ),
    );
    app.get(
      "/api/v1/events/:eventId",
      { preHandler: eventRead },
      async (request, reply) =>
        mapOperation(
          async () => {
            const detail = await operations.repository.getEventDetail(
              operationContext(request),
              (request.params as { eventId: never }).eventId,
            );
            if (detail === undefined) throw new Error("NOT_FOUND");
            if (operationContext(request).actorType === "api_client")
              return eventStatusResponseSchema.parse({
                eventId: detail.event.eventId,
                correlationId: detail.event.correlationId,
                eventType: detail.event.eventType,
                acceptedAt: detail.event.acceptedAt,
                status: detail.event.status,
              });
            return detail;
          },
          reply,
          request,
        ),
    );
    app.get(
      "/api/v1/deliveries",
      { preHandler: authenticated },
      async (request, reply) =>
        mapOperation(
          async () => {
            const parsed = deliverySearchQuerySchema.parse(
              request.query,
            ) as Record<string, unknown>;
            const page = operationInput(request, "deliveries", parsed);
            const exact = [parsed.deliveryId, parsed.correlationId].filter(
              Boolean,
            );
            if (exact.length > 1) throw new Error("VALIDATION_ERROR");
            const result = await operations.repository.searchDeliveries(
              operationContext(request),
              {
                ...page,
                deliveryId: parsed.deliveryId as never,
                correlationId: parsed.correlationId as never,
                partnerId: parsed.partnerId as string | undefined,
                destinationId: parsed.destinationId as string | undefined,
                status: parsed.status as string | undefined,
                terminalFailure: parsed.terminalFailure as boolean | undefined,
              },
            );
            const cursor = responseCursor(
              operationContext(request),
              page.endpointFingerprint,
              result.cursor,
            );
            return {
              items: result.items,
              ...(cursor === undefined ? {} : { cursor }),
            };
          },
          reply,
          request,
        ),
    );
    app.get(
      "/api/v1/deliveries/:deliveryId",
      { preHandler: authenticated },
      async (request, reply) =>
        mapOperation(
          async () => {
            const detail = await operations.repository.getDeliveryDetail(
              operationContext(request),
              (request.params as { deliveryId: never }).deliveryId,
            );
            if (detail === undefined) throw new Error("NOT_FOUND");
            const current = operationContext(request);
            const policy = replayEligibility({
              state: detail.delivery.state,
              ...(detail.delivery.lastFailureCategory === undefined
                ? {}
                : { failureCategory: detail.delivery.lastFailureCategory }),
              correctionConfirmed: false,
            });
            return {
              ...detail,
              delivery: {
                ...detail.delivery,
                transformedPayload: redactedJson(
                  detail.delivery.transformedPayload,
                  detail.delivery.configSnapshot.redactionPaths,
                ),
                configSnapshot: {
                  ...detail.delivery.configSnapshot,
                  secretReferenceNames: [],
                  authConfiguration: {},
                },
              },
              replayEligibility: {
                allowed:
                  (current.role === "admin" || current.role === "operator") &&
                  (detail.delivery.state === "dead_lettered" ||
                    policy.requiresCorrection),
                requiresCorrection: policy.requiresCorrection,
              },
            };
          },
          reply,
          request,
        ),
    );
    app.post(
      "/api/v1/deliveries/:deliveryId/replays",
      { preHandler: authenticated },
      async (request, reply) =>
        mapOperation(
          async () => {
            const key = request.headers["idempotency-key"];
            if (typeof key !== "string" || key.length < 1 || key.length > 256)
              throw new Error("VALIDATION_ERROR");
            const body = replayRequestSchema.parse(request.body);
            const result = replayResponseSchema.parse(
              await operations.service.replay(operationContext(request), {
                deliveryId: (request.params as { deliveryId: never })
                  .deliveryId,
                idempotencyKey: key,
                reason: body.reason,
                correctionConfirmed: body.correctionConfirmed ?? false,
              }),
            );
            return reply
              .code(result.previouslyAccepted ? 200 : 202)
              .send(result);
          },
          reply,
          request,
        ),
    );
    app.get(
      "/api/v1/audit-logs",
      { preHandler: authenticated },
      async (request, reply) =>
        mapOperation(
          async () => {
            const parsed = auditSearchQuerySchema.parse(
              request.query,
            ) as Record<string, unknown>;
            const page = operationInput(request, "audit-logs", parsed);
            const result = await operations.repository.listAudit(
              operationContext(request),
              {
                ...page,
                status: parsed.action as string | undefined,
                partnerId: parsed.actorId as string | undefined,
                destinationId: parsed.targetType as string | undefined,
                eventType: parsed.targetId as string | undefined,
              },
            );
            const cursor = responseCursor(
              operationContext(request),
              page.endpointFingerprint,
              result.cursor,
            );
            return {
              items: result.items,
              ...(cursor === undefined ? {} : { cursor }),
            };
          },
          reply,
          request,
        ),
    );
    app.get(
      "/api/v1/operational-rollups",
      { preHandler: authenticated },
      async (request, reply) =>
        mapOperation(
          async () => {
            const parsed = rollupQuerySchema.parse(request.query) as Record<
              string,
              unknown
            >;
            const page = operationInput(request, "operational-rollups", {
              ...parsed,
              limit: 1,
            });
            const current = operationContext(request);
            const [rollups, retrying, configured] = await Promise.all([
              operations.repository.getRollups(current, page),
              operations.repository.countDeliveriesByState(
                current,
                "retry_scheduled",
              ),
              operations.repository.listDestinations(current, { limit: 25 }),
            ]);
            const addRollup = (
              target: Record<string, number>,
              value: (typeof rollups)[number],
            ) => {
              for (const [name, amount] of Object.entries(value))
                if (typeof amount === "number")
                  target[name] = (target[name] ?? 0) + amount;
              for (const [bucket, amount] of Object.entries(
                value.latencyBuckets,
              ))
                target[`latencyBucket${bucket}`] =
                  (target[`latencyBucket${bucket}`] ?? 0) + amount;
            };
            const totals: Record<string, number> = {};
            const destinations = new Map<string, Record<string, number>>();
            for (const value of rollups) {
              if (value.destinationId !== undefined) {
                const destination = destinations.get(value.destinationId) ?? {};
                addRollup(destination, value);
                destinations.set(value.destinationId, destination);
              } else addRollup(totals, value);
            }
            const destinationSummaries = await Promise.all(
              configured.items.map(async (destination) => {
                const aggregate =
                  destinations.get(destination.destinationId) ?? {};
                const circuit = await operations.repository.getCircuitState(
                  current,
                  destination.destinationId,
                );
                return {
                  destinationId: destination.destinationId,
                  partnerId: destination.partnerId,
                  name: destination.name,
                  enabled: destination.enabled,
                  circuit,
                  totals: aggregate,
                  averageLatencyMs:
                    (aggregate.latencyCount ?? 0) === 0
                      ? 0
                      : (aggregate.latencyTotalMs ?? 0) /
                        (aggregate.latencyCount ?? 1),
                };
              }),
            );
            return {
              from: page.from,
              to: page.to,
              totals,
              retryingCount: retrying,
              averageLatencyMs:
                (totals.latencyCount ?? 0) === 0
                  ? 0
                  : (totals.latencyTotalMs ?? 0) / (totals.latencyCount ?? 1),
              destinations: destinationSummaries,
            };
          },
          reply,
          request,
        ),
    );
  }
  return app;
}
