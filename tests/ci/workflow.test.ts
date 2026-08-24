import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { parse } from "yaml";

async function workflow(name: string) {
  return parse(
    await readFile(
      new URL(`../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

test("pull request workflow covers M10 engineering, Compose, container, and hybrid gates", async () => {
  const value = await workflow("pull-request.yml");
  expect(value.on.pull_request).toEqual({});
  expect(Object.keys(value.jobs)).toEqual([
    "engineering-gate",
    "compose-profile",
    "compose-smoke",
    "container-scan",
    "m11-hybrid-guard",
  ]);
  const names = value.jobs["engineering-gate"].steps.map(
    (step: { name?: string }) => step.name,
  );
  expect(names).toEqual(
    expect.arrayContaining([
      "Install with frozen lockfile",
      "Format check",
      "Lint",
      "TypeScript compile",
      "Test TypeScript compile",
      "Architecture dependency test",
      "Unit tests",
      "Contract tests",
      "Security test gate",
      "Explicit console production build",
      "Lambda and CDK bundle build",
      "OpenAPI drift",
      "High-severity dependency audit",
      "Source and configuration secret scan",
    ]),
  );
  expect(value.jobs["compose-profile"].strategy.matrix.profile).toEqual([
    "default",
    "observability",
  ]);
  expect(
    value.jobs["compose-profile"].steps.map(
      (step: { name?: string }) => step.name,
    ),
  ).toEqual(
    expect.arrayContaining([
      "Build cached local worker image",
      "Build cached local console image",
      "Verify Compose profile",
    ]),
  );
  expect(value.jobs["compose-smoke"].needs).toBe("compose-profile");
  const trivy = value.jobs["container-scan"].steps.find(
    (step: { uses?: string }) =>
      step.uses === "aquasecurity/trivy-action@v0.36.0",
  );
  expect(trivy?.with).toMatchObject({
    "scan-type": "fs",
    "scan-ref": ".",
    severity: "HIGH,CRITICAL",
    "exit-code": "1",
  });
  for (const job of ["engineering-gate", "compose-profile"])
    expect(
      value.jobs[job].steps.findIndex(
        (step: { uses?: string }) => step.uses === "pnpm/action-setup@v4",
      ),
    ).toBeLessThan(
      value.jobs[job].steps.findIndex(
        (step: { uses?: string }) => step.uses === "actions/setup-node@v5",
      ),
    );
});

test("deployment uses protected OIDC and has a rollback entrypoint", async () => {
  const deploy = await workflow("deploy-demo.yml");
  expect(deploy.permissions["id-token"]).toBe("write");
  expect(deploy.jobs.deploy.environment).toBe("demo");
  expect(JSON.stringify(deploy)).toContain(
    "aws-actions/configure-aws-credentials@v5",
  );
  expect(JSON.stringify(deploy)).not.toContain("AWS_ACCESS_KEY_ID");
  expect(JSON.stringify(deploy)).toContain(
    "Hosted smoke and deployment metadata",
  );
  expect(JSON.stringify(deploy)).toContain("DEMO_ADMIN_PASSWORD");
  expect(JSON.stringify(deploy)).toContain("HOSTED_MOCK_ALPHA_URL");
  expect(
    deploy.jobs.deploy.steps.find(
      (step: { name?: string }) => step.name === "Diff and deploy CDK stacks",
    ).run,
  ).toContain("pnpm --filter @pirh/cdk run diff");
  expect(
    deploy.jobs.deploy.steps.findIndex(
      (step: { uses?: string }) => step.uses === "pnpm/action-setup@v4",
    ),
  ).toBeLessThan(
    deploy.jobs.deploy.steps.findIndex(
      (step: { uses?: string }) => step.uses === "actions/setup-node@v5",
    ),
  );
  const rollback = await workflow("rollback-demo.yml");
  expect(rollback.on.workflow_dispatch.inputs.lambda_version.required).toBe(
    true,
  );
});
