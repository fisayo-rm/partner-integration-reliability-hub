import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

const hybridApp = new URL(
  "../../infrastructure/cdk/src/hybrid-app.ts",
  import.meta.url,
);

test("hybrid CDK stack is dedicated, tagged, and excludes shared namespace access", async () => {
  const source = await readFile(hybridApp, "utf8");
  expect(source).toContain('const stackName = "PirhHybridFisayoRm"');
  expect(source).toContain('environment: "development"');
  expect(source).toContain('"allow-local-development": "true"');
  expect(source).toContain("developer: owner");
  expect(source).toContain("tableName: `${resourcePrefix}-core`");
  expect(source).toContain(
    "queueName: `${resourcePrefix}-${id.toLowerCase()}`",
  );
  expect(source).toContain("const ssmNamespace = `/pirh/hybrid/${owner}`");
  expect(source).toContain("const ssmSecretPrefix = `${ssmNamespace}/tenants`");
  expect(source).toContain('roleName: "PirhHybridFisayoRmDeveloperRole"');
  expect(source).toContain('sid: "DenySharedPIRHNamespaces"');
  expect(source).toContain('sid: "HybridParametersOnly"');
  expect(source).toContain('sid: "HybridSchedulesOnly"');
  expect(source).toContain('sid: "ReadOnlyHybridAttestation"');
  expect(source).toContain('sid: "CallerIdentityForDiagnostics"');
  expect(source).toContain('sid: "HybridQueuesWithoutDiscovery"');
  expect(source).not.toContain("routing.grantConsumeMessages(developer)");
  expect(source).not.toContain('actions: ["iam:*"');
  expect(source).not.toContain('actions: ["cloudformation:*"');
  expect(source).toContain("parameter/pirh/demo/*");
  expect(source).toContain("parameter/pirh/performance/*");
  expect(source).toContain("parameter/pirh/production-reference/*");
});

test("hybrid stack exports the values startup attestation consumes", async () => {
  const source = await readFile(hybridApp, "utf8");
  for (const output of [
    "CoreTableName",
    "AuditTableName",
    "RoutingQueueName",
    "RoutingQueueUrl",
    "DeliveryQueueName",
    "DeliveryQueueUrl",
    "DeliveryQueueArn",
    "SsmNamespace",
    "SsmSecretPrefix",
    "SchedulerGroupName",
    "SchedulerExecutionRoleArn",
    "DeveloperRoleArn",
    "CognitoIssuer",
    "CognitoClientId",
    "MockAlphaUrl",
    "MockBetaUrl",
  ])
    expect(source).toContain(`"${output}"`);
});

test("the demo CDK entrypoint remains isolated from the hybrid stack", async () => {
  const demo = await readFile(
    new URL("../../infrastructure/cdk/src/app.ts", import.meta.url),
    "utf8",
  );
  expect(demo).not.toContain("PirhHybridFisayoRm");
});
