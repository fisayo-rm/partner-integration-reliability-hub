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

test("pull request workflow covers engineering, Compose, container, and hybrid safety gates", async () => {
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
  expect(value.jobs["m11-hybrid-guard"].name).toBe("M11 hybrid guard");
  expect(
    value.jobs["m11-hybrid-guard"].steps.find(
      (step: { name?: string }) =>
        step.name === "Hybrid startup and IAM safety tests",
    ).run,
  ).toBe(
    "pnpm exec vitest run tests/config/hybrid.test.ts tests/cdk/hybrid-stack.test.ts",
  );
  expect(
    value.jobs["m11-hybrid-guard"].steps.find(
      (step: { name?: string }) =>
        step.name === "Build workspace packages for hybrid synth",
    ).run,
  ).toBe("pnpm build");
  expect(JSON.stringify(value.jobs["m11-hybrid-guard"])).toContain(
    "Hybrid startup and IAM safety tests",
  );
  expect(JSON.stringify(value.jobs["m11-hybrid-guard"])).toContain(
    "pnpm hybrid:synth",
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
  expect(JSON.stringify(deploy)).toContain("Hosted smoke");
  expect(JSON.stringify(deploy)).toContain("DEMO_ADMIN_PASSWORD");
  expect(JSON.stringify(deploy)).toContain("HOSTED_MOCK_ALPHA_URL");
  expect(JSON.stringify(deploy)).toContain("OIDC_ISSUER");
  expect(JSON.stringify(deploy)).toContain("VITE_OIDC_AUTHORITY");
  expect(JSON.stringify(deploy)).toContain("VITE_OIDC_HOSTED_LOGIN_AUTHORITY");
  expect(JSON.stringify(deploy)).toContain("pirh-demo-deployment-");
  expect(
    deploy.jobs.deploy.steps.find(
      (step: { name?: string }) =>
        step.name === "Prepare immutable rollback artifact",
    ).env.DEPLOYMENT_METADATA_FILE,
  ).toBe("deployment-artifact/deployment.json");
  expect(
    deploy.jobs.deploy.steps.find(
      (step: { name?: string }) =>
        step.name === "Retain verified deployment artifact",
    ).with.path,
  ).toBe("deployment-artifact");
  expect(
    deploy.jobs.deploy.steps.find(
      (step: { name?: string }) =>
        step.name === "Retain verified deployment artifact",
    ).with["if-no-files-found"],
  ).toBe("error");
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
  expect(rollback.on.workflow_dispatch.inputs.deployment_run_id.required).toBe(
    true,
  );
  expect(rollback.permissions.actions).toBe("read");
  expect(JSON.stringify(rollback)).toContain("gh run download");
  expect(JSON.stringify(rollback)).toContain("CLOUDFLARE_API_TOKEN");
  expect(JSON.stringify(rollback)).toContain("Hosted recovery smoke");
  expect(JSON.stringify(rollback)).toContain("pnpm smoke:hosted");
});

test("GitHub deployment role can discover and restore only demo Lambda aliases", async () => {
  const bootstrap = await readFile(
    new URL(
      "../../infrastructure/bootstrap/github-oidc-demo.yaml",
      import.meta.url,
    ),
    "utf8",
  );

  expect(bootstrap).toContain("Sid: DiscoverDemoAliases");
  expect(bootstrap).toContain("Action: lambda:ListAliases");
  expect(bootstrap).toContain("Sid: RollbackDemoAliases");
  expect(bootstrap).toContain("Action: lambda:UpdateAlias");
  expect(bootstrap).not.toContain("function:PirhDemo*:*");
  expect(bootstrap).toContain("function:PirhDemo*");
});

test("M12 deep verification retains load, recovery, and synthesis evidence", async () => {
  const deep = await workflow("deep-verification.yml");
  expect(deep.on.workflow_dispatch).toEqual({});
  expect(deep.on.schedule).toHaveLength(1);
  const steps = deep.jobs["resilience-load-recovery"].steps;
  expect(steps.map((step: { name?: string }) => step.name)).toEqual(
    expect.arrayContaining([
      "Run M12 engineering and acceptance checks",
      "Synthesize hosted and hybrid infrastructure",
      "Run isolated M12 load scenarios through the local verifier",
      "Run isolated recovery restore drill",
      "Retain deep-verification evidence",
    ]),
  );
  expect(
    steps.find(
      (step: { name?: string }) =>
        step.name === "Run M12 engineering and acceptance checks",
    ).run,
  ).toBe("pnpm verify && pnpm acceptance:validate");
  expect(
    steps.find(
      (step: { name?: string }) =>
        step.name === "Synthesize hosted and hybrid infrastructure",
    ).run,
  ).toBe("pnpm cdk:synth && pnpm hybrid:synth");
  expect(
    steps.find(
      (step: { name?: string }) =>
        step.name === "Run isolated recovery restore drill",
    ).run,
  ).toBe("pnpm restore:drill");
});
