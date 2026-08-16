import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance } from "fastify";
import { apiMetaSchema } from "@pirh/contracts";

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
  return app;
}
