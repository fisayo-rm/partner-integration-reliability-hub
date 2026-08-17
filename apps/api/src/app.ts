import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  apiMetaSchema,
  createDestinationRequestSchema,
  createPartnerRequestSchema,
  createSubscriptionRequestSchema,
  createTransformationRequestSchema,
  createTransformationVersionRequestSchema,
  updateDestinationRequestSchema,
  updatePartnerRequestSchema,
  validateTransformationRequestSchema,
} from "@pirh/contracts";
import {
  ControlPlaneService,
  type ControlPlaneRepository,
  type CoreRepository,
} from "@pirh/application";
import { requireRole, type ConsoleAuthenticator } from "@pirh/auth";
import type {
  Destination,
  Partner,
  TenantContext,
  TransformationVersion,
} from "@pirh/domain";
import { consoleAuthenticationHook } from "./auth.js";

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
  const app = Fastify({ logger: false });
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
