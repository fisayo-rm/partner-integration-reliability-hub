import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { partnerBetaPayloadSchema } from "@pirh/contracts";

export function buildMockPartnerBeta(
  config: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly controlToken: string;
    readonly timeoutMs?: number;
  } = {
    clientId: "beta-demo",
    clientSecret: "beta-demo-secret",
    controlToken: "control",
  },
) {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const parsed: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(String(body)).entries())
        parsed[key] = value;
      done(null, parsed);
    },
  );
  let mode: "success" | "429" | "503" | "timeout" = "success";
  let failRemaining = 0;
  let failFirstOnly = false;
  let retryAfterSeconds = 1;
  const tokens = new Set<string>();
  const captures: unknown[] = [];
  const requests: number[] = [];
  const controlled = (
    request: { headers: Record<string, unknown> },
    reply: { code(code: number): { send(value: unknown): unknown } },
  ) =>
    request.headers["x-mock-control-token"] === config.controlToken
      ? undefined
      : reply.code(403).send({ error: "forbidden" });
  const allowed = () => {
    const now = Date.now();
    while (requests[0] !== undefined && requests[0] < now - 1_000)
      requests.shift();
    if (requests.length >= 10) return false;
    requests.push(now);
    return true;
  };
  const token = (
    headers: Record<string, unknown>,
    body: Record<string, unknown>,
  ) => {
    const basic =
      headers.authorization ===
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
    return (
      basic ||
      (body.client_id === config.clientId &&
        body.client_secret === config.clientSecret)
    );
  };
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ok" }));
  app.post("/oauth/token", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (
      body.grant_type !== "client_credentials" ||
      !token(request.headers, body)
    )
      return reply.code(401).send({ error: "invalid_client" });
    const value = randomBytes(18).toString("base64url");
    tokens.add(value);
    return { access_token: value, token_type: "Bearer", expires_in: 300 };
  });
  app.get("/partner/health", async (request, reply) =>
    typeof request.headers.authorization === "string" &&
    tokens.has(request.headers.authorization.replace(/^Bearer /, ""))
      ? { status: "ok" }
      : reply.code(401).send({ error: "invalid_token" }),
  );
  app.post("/api/shipments", async (request, reply) => {
    const bearer = request.headers.authorization;
    if (
      typeof bearer !== "string" ||
      !tokens.has(bearer.replace(/^Bearer /, ""))
    )
      return reply.code(401).send({ error: "invalid_token" });
    if (!allowed()) return reply.code(429).send({ error: "rate_limited" });
    const payload = partnerBetaPayloadSchema.safeParse(request.body);
    if (!payload.success)
      return reply.code(400).send({ error: "invalid_payload" });
    if (failRemaining > 0) {
      failRemaining -= 1;
      const status = mode === "success" ? 503 : Number(mode);
      return reply
        .code(status)
        .header("Retry-After", String(retryAfterSeconds))
        .send({ error: "controlled" });
    }
    if (failFirstOnly) {
      captures.push({
        body: payload.data,
        headers: {
          "x-correlation-id": request.headers["x-correlation-id"],
          "x-delivery-key": request.headers["x-delivery-key"],
        },
      });
      if (captures.length > 100) captures.shift();
      return reply.code(202).send({ received: true });
    }
    captures.push({
      body: payload.data,
      headers: {
        "x-correlation-id": request.headers["x-correlation-id"],
        "x-delivery-key": request.headers["x-delivery-key"],
      },
    });
    if (captures.length > 100) captures.shift();
    if (mode === "timeout") {
      await new Promise((resolve) =>
        setTimeout(resolve, config.timeoutMs ?? 500),
      );
      return { received: true };
    }
    if (mode === "429")
      return reply
        .code(429)
        .header("Retry-After", String(retryAfterSeconds))
        .send({ error: "controlled" });
    if (mode === "503") return reply.code(503).send({ error: "controlled" });
    return reply.code(202).send({ received: true });
  });
  app.post("/__control/mode", async (request, reply) => {
    const denied = controlled(request, reply);
    if (denied !== undefined) return denied;
    const body = request.body as
      | { mode?: typeof mode; failFirst?: number; retryAfterSeconds?: number }
      | undefined;
    const value = body?.mode;
    if (!value || !["success", "429", "503", "timeout"].includes(value))
      return reply.code(400).send({ error: "invalid_mode" });
    mode = value;
    failFirstOnly = body?.failFirst !== undefined;
    failRemaining = Math.max(0, Math.floor(body?.failFirst ?? 0));
    retryAfterSeconds = Math.max(0, Math.floor(body?.retryAfterSeconds ?? 1));
    return { mode, failRemaining, retryAfterSeconds };
  });
  app.get("/__control/captures", async (request, reply) => {
    const denied = controlled(request, reply);
    return denied ?? { items: captures };
  });
  return app;
}
if (process.argv[1]?.endsWith("index.js")) {
  const app = buildMockPartnerBeta({
    clientId: process.env.MOCK_BETA_CLIENT_ID ?? "beta-demo",
    clientSecret: process.env.MOCK_BETA_CLIENT_SECRET ?? "beta-demo-secret",
    controlToken: process.env.MOCK_CONTROL_TOKEN ?? "control",
    timeoutMs: Number(process.env.MOCK_TIMEOUT_MS ?? 500),
  });
  void app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4012) });
}
