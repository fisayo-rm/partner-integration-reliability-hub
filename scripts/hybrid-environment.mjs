import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

export const hybridAccountId = process.env.AWS_ACCOUNT_ID ?? "204284492447";
export const hybridRegion = process.env.AWS_REGION ?? "us-east-1";
export const hybridStackName =
  process.env.AWS_STACK_NAME ?? "PirhHybridFisayoRm";

export async function loadHybridRuntimeEnvironment() {
  const cloudFormation = new CloudFormationClient({ region: hybridRegion });
  const stack = await cloudFormation.send(
    new DescribeStacksCommand({ StackName: hybridStackName }),
  );
  const outputs = new Map(
    (stack.Stacks?.[0]?.Outputs ?? []).flatMap((value) =>
      typeof value.OutputKey === "string" &&
      typeof value.OutputValue === "string"
        ? [[value.OutputKey, value.OutputValue]]
        : [],
    ),
  );
  const required = (name) => {
    const value = outputs.get(name);
    if (value === undefined) throw new Error(`${name} output is unavailable.`);
    return value;
  };
  const assumed = await new STSClient({ region: hybridRegion }).send(
    new AssumeRoleCommand({
      RoleArn: required("DeveloperRoleArn"),
      RoleSessionName: `pirh-hybrid-${Date.now()}`,
      DurationSeconds: 3600,
    }),
  );
  const credentials = assumed.Credentials;
  if (
    credentials?.AccessKeyId === undefined ||
    credentials.SecretAccessKey === undefined ||
    credentials.SessionToken === undefined
  )
    throw new Error("Hybrid developer role credentials are unavailable.");
  const issuer = required("CognitoIssuer");
  return {
    outputs,
    environment: {
      ...process.env,
      APP_ENV: "hybrid",
      AWS_REGION: hybridRegion,
      AWS_ACCOUNT_ID: hybridAccountId,
      AWS_STACK_NAME: hybridStackName,
      ALLOW_REMOTE_AWS: "true",
      CORE_TABLE_NAME: required("CoreTableName"),
      AUDIT_TABLE_NAME: required("AuditTableName"),
      ROUTING_QUEUE_NAME: required("RoutingQueueName"),
      ROUTING_QUEUE_URL: required("RoutingQueueUrl"),
      DELIVERY_QUEUE_NAME: required("DeliveryQueueName"),
      DELIVERY_QUEUE_URL: required("DeliveryQueueUrl"),
      DELIVERY_QUEUE_ARN: required("DeliveryQueueArn"),
      SSM_NAMESPACE: required("SsmNamespace"),
      SSM_SECRET_PREFIX: required("SsmSecretPrefix"),
      CURSOR_SECRET_PARAMETER: `${required("SsmNamespace")}/system/cursor-secret`,
      PORTABILITY_PLAN_SIGNING_KEY_PARAMETER: `${required("SsmNamespace")}/system/portability-plan-signing-key`,
      SCHEDULER_GROUP_NAME: required("SchedulerGroupName"),
      SCHEDULER_EXECUTION_ROLE_ARN: required("SchedulerExecutionRoleArn"),
      SCHEDULER_NAME_PREFIX: "pirh-hybrid-fisayo-rm",
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: required("CognitoClientId"),
      OIDC_JWKS_URI: `${issuer}/.well-known/jwks.json`,
      MOCK_ALPHA_URL: required("MockAlphaUrl"),
      MOCK_BETA_URL: required("MockBetaUrl"),
      CONSOLE_ORIGIN: "http://localhost:5173",
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
    },
  };
}
