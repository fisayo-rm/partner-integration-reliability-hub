import Fastify from "fastify";
import { partnerAlphaPayloadSchema } from "@pirh/contracts";

export type MockMode = "success" | "429" | "503" | "timeout";
export function buildMockPartnerAlpha(
  config: {
    readonly apiKey: string;
    readonly controlToken: string;
    readonly timeoutMs?: number;
  } = { apiKey: "alpha-demo-key", controlToken: "control" },
) {
  const app = Fastify({ logger: false });
  let mode: MockMode = "success";
  let failRemaining = 0;
  let failFirstOnly = false;
  let retryAfterSeconds = 1;
  const captures: unknown[] = [];
  const idempotency = new Set<string>();
  const requests: number[] = [];
  const control = (
    request: { headers: Record<string, unknown> },
    reply: { code(code: number): { send(value: unknown): unknown } },
  ) =>
    request.headers["x-mock-control-token"] === config.controlToken
      ? undefined
      : reply.code(403).send({ error: "forbidden" });
  const allowed = () => {
    const now = Date.now();
    while (requests[0] !== undefined && requests[0] < now - 60_000)
      requests.shift();
    if (requests.length >= 60) return false;
    requests.push(now);
    return true;
  };
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => ({ status: "ok" }));
  app.get("/partner/health", async (request, reply) =>
    request.headers["x-api-key"] === config.apiKey
      ? { status: "ok" }
      : reply.code(401).send({ error: "invalid_api_key" }),
  );
  app.post("/webhooks/shipments", async (request, reply) => {
    if (request.headers["x-api-key"] !== config.apiKey)
      return reply.code(401).send({ error: "invalid_api_key" });
    if (!allowed()) return reply.code(429).send({ error: "rate_limited" });
    const payload = partnerAlphaPayloadSchema.safeParse(request.body);
    if (!payload.success)
      return reply.code(400).send({ error: "invalid_payload" });
    if (failRemaining > 0) {
      failRemaining -= 1;
      return reply
        .code(mode === "success" ? 503 : Number(mode))
        .header("Retry-After", String(retryAfterSeconds))
        .send({ error: "controlled" });
    }
    if (failFirstOnly) {
      captures.push({
        body: payload.data,
        headers: {
          "x-correlation-id": request.headers["x-correlation-id"],
          "idempotency-key": request.headers["idempotency-key"],
        },
      });
      if (captures.length > 100) captures.shift();
      return reply.code(202).send({ received: true });
    }
    const key = request.headers["idempotency-key"];
    if (typeof key === "string" && idempotency.has(key))
      return reply.code(200).send({ duplicate: true });
    if (typeof key === "string") idempotency.add(key);
    captures.push({
      body: payload.data,
      headers: {
        "x-correlation-id": request.headers["x-correlation-id"],
        "idempotency-key": key,
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
    const denied = control(request, reply);
    if (denied !== undefined) return denied;
    const body = request.body as
      | { mode?: MockMode; failFirst?: number; retryAfterSeconds?: number }
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
    const denied = control(request, reply);
    return denied ?? { items: captures };
  });
  return app;
}
if (process.argv[1]?.endsWith("index.js")) {
  const app = buildMockPartnerAlpha({
    apiKey: process.env.MOCK_ALPHA_API_KEY ?? "alpha-demo-key",
    controlToken: process.env.MOCK_CONTROL_TOKEN ?? "control",
    timeoutMs: Number(process.env.MOCK_TIMEOUT_MS ?? 500),
  });
  void app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4011) });
}
