import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("pull-request workflow runs Stage A and the local platform/integration smoke", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/pull-request.yml", import.meta.url),
      "utf8",
    ),
  );
  const jobs = workflow.jobs;
  expect(workflow.on.pull_request).toEqual({});
  expect(Object.keys(jobs)).toEqual(["stage-a", "local-platform"]);
  const steps = jobs["stage-a"].steps;
  const names = steps.map((step: { name?: string }) => step.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "Install with frozen lockfile",
      "Format check",
      "Lint",
      "TypeScript compile",
      "Test TypeScript compile",
      "Architecture dependency test",
      "Unit tests",
      "Security test gate",
      "Build all workspaces",
      "Explicit console production build",
      "High-severity dependency audit",
      "Source and configuration secret scan",
    ]),
  );
  const commands = steps
    .map((step: { run?: string }) => step.run)
    .filter(Boolean);
  expect(commands).toEqual(
    expect.arrayContaining([
      "pnpm format:check",
      "pnpm test:typecheck",
      "pnpm test",
      "pnpm test:security",
      "pnpm build",
    ]),
  );
  expect(
    jobs["local-platform"].steps.map((step: { name?: string }) => step.name),
  ).toContain("Verify Compose topology");
  expect(
    jobs["local-platform"].steps.map((step: { name?: string }) => step.name),
  ).toContain("Install Playwright Chromium");
});
