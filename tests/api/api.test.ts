import { expect, test } from "vitest";
import { buildApi } from "../../apps/api/src/app.js";

const ready = async (name: string) => ({ name, ok: true });
test("shared API exposes health, metadata, and OpenAPI skeleton", async () => {
  const app = await buildApi({
    requiredConfiguration: () => ready("configuration"),
    dynamoDb: () => ready("dynamodb"),
    elasticMq: () => ready("elasticmq"),
  });
  try {
    expect((await app.inject("/health/live")).statusCode).toBe(200);
    expect((await app.inject("/health/ready")).json().status).toBe("ready");
    expect((await app.inject("/api/v1/meta")).json().mode).toBe("skeleton");
    expect((await app.inject("/openapi.json")).json().openapi).toBe("3.1.0");
  } finally {
    await app.close();
  }
});
test("readiness is bounded by injected dependency probes", async () => {
  const app = await buildApi({
    requiredConfiguration: () => ready("configuration"),
    dynamoDb: () => ready("dynamodb"),
    elasticMq: async () => ({
      name: "elasticmq",
      ok: false,
      detail: "unreachable",
    }),
  });
  try {
    expect((await app.inject("/health/ready")).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});
