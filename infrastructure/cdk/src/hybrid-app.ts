import {
  App,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
} from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { AwsSolutionsChecks } from "cdk-nag";
import { join } from "node:path";
import { lambdaHandler } from "./handler.js";

const account = process.env.CDK_DEFAULT_ACCOUNT ?? "204284492447";
const region = process.env.CDK_DEFAULT_REGION ?? "us-east-1";
const owner = "fisayo-rm";
const resourcePrefix = "pirh-hybrid-fisayo-rm";
const stackName = "PirhHybridFisayoRm";
const source = (...parts: string[]) =>
  join(process.cwd(), "..", "..", ...parts);

class HybridStack extends Stack {
  public constructor(scope: App) {
    super(scope, stackName, {
      env: { account, region },
      stackName,
      description:
        "Partner Integration Reliability Hub per-developer hybrid development environment",
    });

    for (const [key, value] of Object.entries({
      project: "partner-integration-reliability-hub",
      environment: "development",
      "allow-local-development": "true",
      developer: owner,
      owner: "fisayo-rm",
      "managed-by": "cdk",
      "cost-center": "project-demo",
    }))
      Tags.of(this).add(key, value);

    const core = new dynamodb.Table(this, "Core", {
      tableName: `${resourcePrefix}-core`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    core.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });
    const audit = new dynamodb.Table(this, "Audit", {
      tableName: `${resourcePrefix}-audit`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const queue = (id: string, retention: Duration) => {
      const dlq = new sqs.Queue(this, `${id}Dlq`, {
        queueName: `${resourcePrefix}-${id.toLowerCase()}-dlq`,
        retentionPeriod: Duration.days(7),
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new sqs.Queue(this, id, {
        queueName: `${resourcePrefix}-${id.toLowerCase()}`,
        retentionPeriod: retention,
        visibilityTimeout: Duration.seconds(360),
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
        removalPolicy: RemovalPolicy.DESTROY,
      });
    };
    const routing = queue("Routing", Duration.days(4));
    const delivery = queue("Delivery", Duration.days(7));

    const schedulerGroupName = `${resourcePrefix}-schedules`;
    new scheduler.CfnScheduleGroup(this, "Schedules", {
      name: schedulerGroupName,
    });
    const schedulerRole = new iam.Role(this, "SchedulerExecutionRole", {
      roleName: "PirhHybridFisayoRmSchedulerExecutionRole",
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      maxSessionDuration: Duration.hours(1),
    });
    delivery.grantSendMessages(schedulerRole);

    const userPool = new cognito.UserPool(this, "ConsoleUsers", {
      userPoolName: `${resourcePrefix}-console-users`,
      selfSignUpEnabled: false,
      removalPolicy: RemovalPolicy.DESTROY,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 14,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });
    for (const groupName of ["viewer", "operator", "admin"])
      new cognito.CfnUserPoolGroup(this, `Group${groupName}`, {
        groupName,
        userPoolId: userPool.userPoolId,
      });
    const userPoolClient = userPool.addClient("ConsoleSpa", {
      userPoolClientName: `${resourcePrefix}-console-spa`,
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ["http://localhost:5173/auth/callback"],
        logoutUrls: ["http://localhost:5173/", "http://localhost:5173/login"],
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });
    const hostedLoginDomain = userPool.addDomain("HostedLoginDomain", {
      cognitoDomain: { domainPrefix: `${resourcePrefix}-auth` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    new cognito.CfnManagedLoginBranding(this, "ConsoleManagedLoginBranding", {
      clientId: userPoolClient.userPoolClientId,
      userPoolId: userPool.userPoolId,
      useCognitoProvidedValues: true,
    });

    const ssmNamespace = `/pirh/hybrid/${owner}`;
    const ssmSecretPrefix = `${ssmNamespace}/tenants`;
    const mockPartner = (
      id: "MockAlpha" | "MockBeta",
      entry: string,
      environment: Record<string, string>,
    ) => {
      const value = new NodejsFunction(this, id, {
        functionName: `PirhHybridFisayoRm${id}`,
        entry: source(entry),
        handler: lambdaHandler(id),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(15),
        tracing: lambda.Tracing.ACTIVE,
        environment: { APP_ENV: "hybrid", ...environment },
        bundling: { minify: true, sourceMap: true, target: "node24" },
      });
      core.grantReadWriteData(value);
      value.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:aws:ssm:${region}:${account}:parameter${ssmNamespace}/*`,
          ],
        }),
      );
      const alias = new lambda.Alias(this, `${id}Live`, {
        aliasName: "live",
        version: value.currentVersion,
      });
      return alias.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
        invokeMode: lambda.InvokeMode.BUFFERED,
      });
    };
    const alphaUrl = mockPartner(
      "MockAlpha",
      "apps/mock-partner-alpha/src/lambda.ts",
      {
        MOCK_CONTROL_TOKEN_PARAMETER: `${ssmNamespace}/system/mock-control-token`,
        MOCK_ALPHA_API_KEY_PARAMETER: `${ssmNamespace}/mock/alpha/api-key`,
      },
    );
    const betaUrl = mockPartner(
      "MockBeta",
      "apps/mock-partner-beta/src/lambda.ts",
      {
        MOCK_CONTROL_TOKEN_PARAMETER: `${ssmNamespace}/system/mock-control-token`,
        MOCK_BETA_CLIENT_ID_PARAMETER: `${ssmNamespace}/mock/beta/client-id`,
        MOCK_BETA_CLIENT_SECRET_PARAMETER: `${ssmNamespace}/mock/beta/client-secret`,
      },
    );

    const developer = new iam.Role(this, "DeveloperRole", {
      roleName: "PirhHybridFisayoRmDeveloperRole",
      description:
        "Least-privilege local development role for the PIRH hybrid stack",
      assumedBy: new iam.AccountPrincipal(account),
      maxSessionDuration: Duration.hours(1),
    });
    core.grantReadWriteData(developer);
    audit.grantReadWriteData(developer);
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "HybridQueuesWithoutDiscovery",
        actions: [
          "sqs:ChangeMessageVisibility",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:ReceiveMessage",
          "sqs:SendMessage",
        ],
        resources: [routing.queueArn, delivery.queueArn],
      }),
    );
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "HybridParametersOnly",
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${region}:${account}:parameter${ssmNamespace}/*`,
        ],
      }),
    );
    // Generated-policy analysis of the runtime SDK calls requires decryption
    // only through SSM. The SSM managed key ID is account-owned and therefore
    // cannot be named statically; ViaService prevents direct KMS use.
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "DecryptOnlyThroughHybridSsm",
        actions: ["kms:Decrypt"],
        resources: [`arn:aws:kms:${region}:${account}:key/*`],
        conditions: {
          StringEquals: { "kms:ViaService": `ssm.${region}.amazonaws.com` },
        },
      }),
    );
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "HybridSchedulesOnly",
        actions: [
          "scheduler:CreateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
        ],
        resources: [
          `arn:aws:scheduler:${region}:${account}:schedule/${schedulerGroupName}/${resourcePrefix}-*`,
        ],
      }),
    );
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassOnlyHybridSchedulerRole",
        actions: ["iam:PassRole"],
        resources: [schedulerRole.roleArn],
        conditions: {
          StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
        },
      }),
    );
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadOnlyHybridAttestation",
        actions: ["cloudformation:DescribeStacks"],
        resources: [this.stackId],
      }),
    );
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "CallerIdentityForDiagnostics",
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );
    developer.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenySharedPIRHNamespaces",
        effect: iam.Effect.DENY,
        actions: ["dynamodb:*", "sqs:*", "ssm:*"],
        resources: [
          `arn:aws:dynamodb:${region}:${account}:table/pirh-demo-*`,
          `arn:aws:dynamodb:${region}:${account}:table/pirh-performance-*`,
          `arn:aws:dynamodb:${region}:${account}:table/pirh-production-reference-*`,
          `arn:aws:sqs:${region}:${account}:pirh-demo-*`,
          `arn:aws:sqs:${region}:${account}:pirh-performance-*`,
          `arn:aws:sqs:${region}:${account}:pirh-production-reference-*`,
          `arn:aws:ssm:${region}:${account}:parameter/pirh/demo/*`,
          `arn:aws:ssm:${region}:${account}:parameter/pirh/performance/*`,
          `arn:aws:ssm:${region}:${account}:parameter/pirh/production-reference/*`,
        ],
      }),
    );

    for (const [key, value] of [
      ["CoreTableName", core.tableName],
      ["AuditTableName", audit.tableName],
      ["RoutingQueueName", routing.queueName],
      ["RoutingQueueUrl", routing.queueUrl],
      ["DeliveryQueueName", delivery.queueName],
      ["DeliveryQueueUrl", delivery.queueUrl],
      ["DeliveryQueueArn", delivery.queueArn],
      ["SsmNamespace", ssmNamespace],
      ["SsmSecretPrefix", ssmSecretPrefix],
      ["SchedulerGroupName", schedulerGroupName],
      ["SchedulerExecutionRoleArn", schedulerRole.roleArn],
      ["DeveloperRoleArn", developer.roleArn],
      ["CognitoIssuer", userPool.userPoolProviderUrl],
      ["CognitoClientId", userPoolClient.userPoolClientId],
      ["CognitoHostedLoginAuthority", hostedLoginDomain.baseUrl()],
      ["MockAlphaUrl", alphaUrl.url],
      ["MockBetaUrl", betaUrl.url],
    ] as const)
      new CfnOutput(this, key, { value });
  }
}

const app = new App();
new HybridStack(app);
new AwsSolutionsChecks(app);
app.synth();
