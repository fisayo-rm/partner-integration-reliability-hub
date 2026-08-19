import { expect, test } from "vitest";
import {
  cloudWatchAlarmDefinitions,
  dashboardPanels,
} from "../../packages/observability/src/index.js";

test("M07 operational catalog has bounded alarm definitions and dashboard coverage", () => {
  expect(cloudWatchAlarmDefinitions.map((alarm) => alarm.name)).toEqual(
    expect.arrayContaining([
      "infrastructure-dlq-depth",
      "outbox-oldest-age",
      "delivery-error-rate",
    ]),
  );
  expect(dashboardPanels).toEqual(
    expect.arrayContaining([
      "API health",
      "Replay outcomes",
      "Structured logs",
    ]),
  );
});
