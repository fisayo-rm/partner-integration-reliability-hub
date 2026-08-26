import { expect, test } from "vitest";
import {
  EnvironmentProfileError,
  assertLocalProcessProfile,
  environmentProfile,
  guardLocalProcessStartup,
  loadHybridEnvironment,
  type HybridAttestationClients,
} from "../../packages/config/src/index.js";

const environment = {
  APP_ENV: "hybrid",
  ALLOW_REMOTE_AWS: "true",
  AWS_REGION: "us-east-1",
  AWS_ACCOUNT_ID: "204284492447",
  AWS_STACK_NAME: "PirhHybridFisayoRm",
  CORE_TABLE_NAME: "pirh-hybrid-fisayo-rm-core",
  AUDIT_TABLE_NAME: "pirh-hybrid-fisayo-rm-audit",
  ROUTING_QUEUE_NAME: "pirh-hybrid-fisayo-rm-routing",
  ROUTING_QUEUE_URL:
    "https://sqs.us-east-1.amazonaws.com/204284492447/pirh-hybrid-fisayo-rm-routing",
  DELIVERY_QUEUE_NAME: "pirh-hybrid-fisayo-rm-delivery",
  DELIVERY_QUEUE_URL:
    "https://sqs.us-east-1.amazonaws.com/204284492447/pirh-hybrid-fisayo-rm-delivery",
  DELIVERY_QUEUE_ARN:
    "arn:aws:sqs:us-east-1:204284492447:pirh-hybrid-fisayo-rm-delivery",
  SSM_NAMESPACE: "/pirh/hybrid/fisayo-rm",
  SSM_SECRET_PREFIX: "/pirh/hybrid/fisayo-rm/tenants",
  SCHEDULER_GROUP_NAME: "pirh-hybrid-fisayo-rm-schedules",
  SCHEDULER_EXECUTION_ROLE_ARN:
    "arn:aws:iam::204284492447:role/PirhHybridFisayoRmSchedulerExecutionRole",
  OIDC_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_hybrid",
  OIDC_AUDIENCE: "hybrid-client-id",
  MOCK_ALPHA_URL: "https://alpha.example.test/",
  MOCK_BETA_URL: "https://beta.example.test/",
} as const;

function clients(
  input: {
    readonly account?: string;
    readonly tags?: Readonly<Record<string, string>>;
    readonly outputs?: Readonly<Record<string, string>>;
    readonly arn?: string;
    readonly onDescribe?: () => void;
  } = {},
): HybridAttestationClients {
  const config = loadHybridEnvironment(environment);
  const outputs = {
    CoreTableName: config.coreTableName,
    AuditTableName: config.auditTableName,
    RoutingQueueName: config.routingQueueName,
    RoutingQueueUrl: config.routingQueueUrl,
    DeliveryQueueName: config.deliveryQueueName,
    DeliveryQueueUrl: config.deliveryQueueUrl,
    DeliveryQueueArn: config.deliveryQueueArn,
    SsmNamespace: config.ssmNamespace,
    SsmSecretPrefix: config.ssmSecretPrefix,
    SchedulerGroupName: config.schedulerGroupName,
    SchedulerExecutionRoleArn: config.schedulerExecutionRoleArn,
    CognitoIssuer: config.oidcIssuer,
    CognitoClientId: config.oidcAudience,
    MockAlphaUrl: config.mockAlphaUrl,
    MockBetaUrl: config.mockBetaUrl,
    DeveloperRoleArn:
      "arn:aws:iam::204284492447:role/PirhHybridFisayoRmDeveloperRole",
    ...input.outputs,
  };
  return {
    getCallerIdentity: async () => ({
      Account: input.account ?? config.accountId,
      Arn:
        input.arn ??
        "arn:aws:sts::204284492447:assumed-role/PirhHybridFisayoRmDeveloperRole/sensitive-session-value",
    }),
    describeStack: async () => {
      input.onDescribe?.();
      return {
        Stacks: [
          {
            Tags: Object.entries({
              environment: "development",
              "allow-local-development": "true",
              project: "partner-integration-reliability-hub",
              ...input.tags,
            }).map(([Key, Value]) => ({ Key, Value })),
            Outputs: Object.entries(outputs).map(
              ([OutputKey, OutputValue]) => ({
                OutputKey,
                OutputValue,
              }),
            ),
          },
        ],
      };
    },
  };
}

test("local is the credential-free default and does not construct attestation clients", async () => {
  await expect(
    guardLocalProcessStartup({
      environment: {},
      clients: {
        getCallerIdentity: async () => {
          throw new Error("must not be called");
        },
        describeStack: async () => {
          throw new Error("must not be called");
        },
      },
    }),
  ).resolves.toBe("local");
  expect(environmentProfile({})).toBe("local");
});

test("hybrid requires exact opt-in and all required resource inputs", () => {
  expect(() => loadHybridEnvironment({ APP_ENV: "hybrid" })).toThrow(
    "ALLOW_REMOTE_AWS=true",
  );
  expect(() =>
    loadHybridEnvironment({ ...environment, ALLOW_REMOTE_AWS: "TRUE" }),
  ).toThrow("ALLOW_REMOTE_AWS=true");
  expect(() => environmentProfile({ APP_ENV: "staging" })).toThrow(
    "not supported",
  );
});

test("account mismatch fails before stack inspection", async () => {
  let described = false;
  await expect(
    guardLocalProcessStartup({
      environment,
      clients: clients({
        account: "000000000000",
        onDescribe: () => (described = true),
      }),
    }),
  ).rejects.toThrow("account attestation failed");
  expect(described).toBe(false);
});

test("tag, caller-role, and resource-stack mismatches fail closed", async () => {
  await expect(
    guardLocalProcessStartup({
      environment,
      clients: clients({ tags: { "allow-local-development": "false" } }),
    }),
  ).rejects.toThrow("tag attestation failed");
  await expect(
    guardLocalProcessStartup({
      environment,
      clients: clients({
        outputs: { DeliveryQueueName: "pirh-demo-delivery" },
      }),
    }),
  ).rejects.toThrow("stack-membership attestation failed");
  await expect(
    guardLocalProcessStartup({
      environment,
      clients: clients({ arn: "arn:aws:iam::204284492447:root" }),
    }),
  ).rejects.toThrow("not the dedicated development role");
});

test("diagnostics are allowlisted and redact caller sessions and ambient secrets", async () => {
  const results: unknown[] = [];
  await expect(
    guardLocalProcessStartup({
      environment: {
        ...environment,
        AWS_SECRET_ACCESS_KEY: "must-not-appear",
        AWS_SESSION_TOKEN: "must-not-appear",
      },
      clients: clients(),
      diagnostics: (result) => results.push(result),
    }),
  ).resolves.toBe("hybrid");
  const rendered = JSON.stringify(results);
  expect(rendered).toContain(
    "assumed-role/PirhHybridFisayoRmDeveloperRole/[redacted]",
  );
  expect(rendered).not.toContain("sensitive-session-value");
  expect(rendered).not.toContain("must-not-appear");
});

test("local process entry points reject shared hosted profiles", () => {
  for (const APP_ENV of ["demo", "performance", "production-reference"])
    expect(() => assertLocalProcessProfile({ APP_ENV })).toThrow(
      EnvironmentProfileError,
    );
});
