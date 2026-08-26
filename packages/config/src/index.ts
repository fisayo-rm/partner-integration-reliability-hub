import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

export const environmentProfiles = [
  "local",
  "hybrid",
  "demo",
  "performance",
  "production-reference",
] as const;
export type EnvironmentProfile = (typeof environmentProfiles)[number];

export interface HybridEnvironmentConfig {
  readonly profile: "hybrid";
  readonly region: string;
  readonly accountId: string;
  readonly stackName: string;
  readonly coreTableName: string;
  readonly auditTableName: string;
  readonly routingQueueName: string;
  readonly routingQueueUrl: string;
  readonly deliveryQueueName: string;
  readonly deliveryQueueUrl: string;
  readonly deliveryQueueArn: string;
  readonly ssmNamespace: string;
  readonly ssmSecretPrefix: string;
  readonly schedulerGroupName: string;
  readonly schedulerExecutionRoleArn: string;
  readonly oidcIssuer: string;
  readonly oidcAudience: string;
  readonly mockAlphaUrl: string;
  readonly mockBetaUrl: string;
}

export interface HybridAttestationResult {
  readonly profile: "hybrid";
  readonly accountId: string;
  readonly region: string;
  readonly stackName: string;
  readonly caller: string;
  readonly attestation: "passed";
}

export interface HybridAttestationClients {
  readonly getCallerIdentity: () => Promise<{
    readonly Account?: string | undefined;
    readonly Arn?: string | undefined;
  }>;
  readonly describeStack: (stackName: string) => Promise<{
    readonly Stacks?:
      | readonly {
          readonly StackId?: string | undefined;
          readonly Tags?:
            | readonly {
                readonly Key?: string | undefined;
                readonly Value?: string | undefined;
              }[]
            | undefined;
          readonly Outputs?:
            | readonly {
                readonly OutputKey?: string | undefined;
                readonly OutputValue?: string | undefined;
              }[]
            | undefined;
        }[]
      | undefined;
  }>;
}

export class EnvironmentProfileError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EnvironmentProfileError";
  }
}

type Environment =
  | NodeJS.ProcessEnv
  | Readonly<Record<string, string | undefined>>;

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0)
    throw new EnvironmentProfileError(`${name} is required for hybrid mode.`);
  return value;
}

export function environmentProfile(
  environment: Environment = process.env,
): EnvironmentProfile {
  const value = environment.APP_ENV ?? "local";
  if ((environmentProfiles as readonly string[]).includes(value))
    return value as EnvironmentProfile;
  throw new EnvironmentProfileError(`APP_ENV '${value}' is not supported.`);
}

export function loadHybridEnvironment(
  environment: Environment = process.env,
): HybridEnvironmentConfig {
  if (environmentProfile(environment) !== "hybrid")
    throw new EnvironmentProfileError("APP_ENV must be hybrid.");
  if (environment.ALLOW_REMOTE_AWS !== "true")
    throw new EnvironmentProfileError(
      "ALLOW_REMOTE_AWS=true is required for hybrid mode.",
    );
  return {
    profile: "hybrid",
    region: required(environment, "AWS_REGION"),
    accountId: required(environment, "AWS_ACCOUNT_ID"),
    stackName: required(environment, "AWS_STACK_NAME"),
    coreTableName: required(environment, "CORE_TABLE_NAME"),
    auditTableName: required(environment, "AUDIT_TABLE_NAME"),
    routingQueueName: required(environment, "ROUTING_QUEUE_NAME"),
    routingQueueUrl: required(environment, "ROUTING_QUEUE_URL"),
    deliveryQueueName: required(environment, "DELIVERY_QUEUE_NAME"),
    deliveryQueueUrl: required(environment, "DELIVERY_QUEUE_URL"),
    deliveryQueueArn: required(environment, "DELIVERY_QUEUE_ARN"),
    ssmNamespace: required(environment, "SSM_NAMESPACE"),
    ssmSecretPrefix: required(environment, "SSM_SECRET_PREFIX"),
    schedulerGroupName: required(environment, "SCHEDULER_GROUP_NAME"),
    schedulerExecutionRoleArn: required(
      environment,
      "SCHEDULER_EXECUTION_ROLE_ARN",
    ),
    oidcIssuer: required(environment, "OIDC_ISSUER"),
    oidcAudience: required(environment, "OIDC_AUDIENCE"),
    mockAlphaUrl: required(environment, "MOCK_ALPHA_URL"),
    mockBetaUrl: required(environment, "MOCK_BETA_URL"),
  };
}

export function assertLocalProcessProfile(
  environment: Environment = process.env,
): EnvironmentProfile {
  const profile = environmentProfile(environment);
  if (profile !== "local" && profile !== "hybrid")
    throw new EnvironmentProfileError(
      `A local process cannot run with APP_ENV=${profile}.`,
    );
  return profile;
}

function defaultClients(region: string): HybridAttestationClients {
  const sts = new STSClient({ region });
  const cloudFormation = new CloudFormationClient({ region });
  return {
    getCallerIdentity: async () =>
      await sts.send(new GetCallerIdentityCommand({})),
    describeStack: async (stackName) =>
      await cloudFormation.send(
        new DescribeStacksCommand({ StackName: stackName }),
      ),
  };
}

function tags(
  values: readonly {
    readonly Key?: string | undefined;
    readonly Value?: string | undefined;
  }[],
) {
  return new Map(
    values.flatMap((value) =>
      typeof value.Key === "string" && typeof value.Value === "string"
        ? [[value.Key, value.Value] as const]
        : [],
    ),
  );
}

function outputs(
  values: readonly {
    readonly OutputKey?: string | undefined;
    readonly OutputValue?: string | undefined;
  }[],
) {
  return new Map(
    values.flatMap((value) =>
      typeof value.OutputKey === "string" &&
      typeof value.OutputValue === "string"
        ? [[value.OutputKey, value.OutputValue] as const]
        : [],
    ),
  );
}

function expectedAssumedRoleArn(roleArn: string): string {
  const match = /^arn:([^:]+):iam::(\d+):role\/(.+)$/.exec(roleArn);
  if (match === null)
    throw new EnvironmentProfileError(
      "Hybrid stack returned an invalid role ARN.",
    );
  const [, partition, accountId, roleName] = match;
  return `arn:${partition}:sts::${accountId}:assumed-role/${roleName}/`;
}

export function redactCallerIdentity(arn: string): string {
  const match = /^arn:([^:]+):sts::(\d+):assumed-role\/([^/]+)\/.+$/.exec(arn);
  if (match === null) return "unrecognized/[redacted]";
  return `assumed-role/${match[3]}/[redacted]`;
}

/**
 * Attests the exact remote resource set before a local process begins remote
 * work. The dependency injection boundary keeps all safety checks testable
 * without ambient credentials.
 */
export async function attestHybridEnvironment(
  config: HybridEnvironmentConfig,
  clients: HybridAttestationClients = defaultClients(config.region),
): Promise<HybridAttestationResult> {
  const identity = await clients.getCallerIdentity();
  if (identity.Account !== config.accountId)
    throw new EnvironmentProfileError("Hybrid AWS account attestation failed.");
  if (typeof identity.Arn !== "string")
    throw new EnvironmentProfileError(
      "Hybrid caller identity is unavailable for diagnostics.",
    );

  const response = await clients.describeStack(config.stackName);
  const stack = response.Stacks?.[0];
  if (stack === undefined)
    throw new EnvironmentProfileError(
      "Hybrid development stack is unavailable.",
    );
  const stackTags = tags(stack.Tags ?? []);
  for (const [name, value] of [
    ["environment", "development"],
    ["allow-local-development", "true"],
    ["project", "partner-integration-reliability-hub"],
  ] as const)
    if (stackTags.get(name) !== value)
      throw new EnvironmentProfileError("Hybrid stack tag attestation failed.");

  const stackOutputs = outputs(stack.Outputs ?? []);
  const expected = new Map([
    ["CoreTableName", config.coreTableName],
    ["AuditTableName", config.auditTableName],
    ["RoutingQueueName", config.routingQueueName],
    ["RoutingQueueUrl", config.routingQueueUrl],
    ["DeliveryQueueName", config.deliveryQueueName],
    ["DeliveryQueueUrl", config.deliveryQueueUrl],
    ["DeliveryQueueArn", config.deliveryQueueArn],
    ["SsmNamespace", config.ssmNamespace],
    ["SsmSecretPrefix", config.ssmSecretPrefix],
    ["SchedulerGroupName", config.schedulerGroupName],
    ["SchedulerExecutionRoleArn", config.schedulerExecutionRoleArn],
    ["CognitoIssuer", config.oidcIssuer],
    ["CognitoClientId", config.oidcAudience],
    ["MockAlphaUrl", config.mockAlphaUrl],
    ["MockBetaUrl", config.mockBetaUrl],
  ]);
  for (const [key, value] of expected)
    if (stackOutputs.get(key) !== value)
      throw new EnvironmentProfileError(
        "Hybrid resource stack-membership attestation failed.",
      );

  const developerRoleArn = stackOutputs.get("DeveloperRoleArn");
  if (
    developerRoleArn === undefined ||
    !identity.Arn.startsWith(expectedAssumedRoleArn(developerRoleArn))
  )
    throw new EnvironmentProfileError(
      "Hybrid caller is not the dedicated development role.",
    );

  return {
    profile: "hybrid",
    accountId: config.accountId,
    region: config.region,
    stackName: config.stackName,
    caller: redactCallerIdentity(identity.Arn),
    attestation: "passed",
  };
}

export async function guardLocalProcessStartup(
  input: {
    readonly environment?: Environment;
    readonly clients?: HybridAttestationClients;
    readonly diagnostics?: (result: HybridAttestationResult) => void;
  } = {},
): Promise<EnvironmentProfile> {
  const environment = input.environment ?? process.env;
  const profile = assertLocalProcessProfile(environment);
  if (profile === "local") return profile;
  const result = await attestHybridEnvironment(
    loadHybridEnvironment(environment),
    input.clients,
  );
  input.diagnostics?.(result);
  return profile;
}
