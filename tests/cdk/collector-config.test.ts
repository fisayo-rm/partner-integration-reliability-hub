import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { expect, test } from "vitest";

test("the pinned ARM64 ADOT extension collector config uses only supported components", async () => {
  const config = parse(
    await readFile(
      new URL("../../infrastructure/cdk/src/collector.yaml", import.meta.url),
      "utf8",
    ),
  );

  expect(config).toMatchObject({
    receivers: { otlp: { protocols: { http: { endpoint: "0.0.0.0:4318" } } } },
    exporters: {
      awsxray: null,
      awsemf: { namespace: "PIRH/Demo", log_group_name: "/aws/otel/pirh-demo" },
    },
    service: {
      pipelines: {
        traces: { receivers: ["otlp"], exporters: ["awsxray"] },
        metrics: { receivers: ["otlp"], exporters: ["awsemf"] },
      },
    },
  });
  expect(config.processors).toBeUndefined();
  expect(config.service.pipelines.traces.processors).toBeUndefined();
  expect(config.service.pipelines.metrics.processors).toBeUndefined();
});
