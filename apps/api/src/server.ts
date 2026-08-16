import { buildApi, type HealthProbe } from "./app.js";

const port = Number.parseInt(process.env.API_PORT ?? "3000", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const timeoutMs = 1_000;
function httpProbe(name: string, url: string): HealthProbe {
  return async () => {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        name,
        ok: response.status < 500,
        detail: `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.message : "probe failed",
      };
    }
  };
}
const requiredConfiguration: HealthProbe = async () => ({
  name: "configuration",
  ok: Boolean(
    process.env.APP_ENV &&
      process.env.DYNAMODB_ENDPOINT &&
      process.env.ELASTICMQ_ENDPOINT,
  ),
  detail: "APP_ENV, DYNAMODB_ENDPOINT, and ELASTICMQ_ENDPOINT are required",
});
const app = await buildApi({
  requiredConfiguration,
  dynamoDb: httpProbe(
    "dynamodb",
    process.env.DYNAMODB_ENDPOINT ?? "http://dynamodb-local:8000",
  ),
  elasticMq: httpProbe(
    "elasticmq",
    process.env.ELASTICMQ_ENDPOINT ?? "http://elasticmq:9324",
  ),
});
await app.listen({ host, port });
