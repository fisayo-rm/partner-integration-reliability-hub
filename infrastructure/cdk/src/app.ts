import {
  App,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Tags,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEvents from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { AwsSolutionsChecks } from "cdk-nag";
import { join } from "node:path";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID;
const region = process.env.CDK_DEFAULT_REGION ?? "us-east-1";
const env = account === undefined ? undefined : { account, region };
const source = (...parts: string[]) =>
  join(process.cwd(), "..", "..", ...parts);
const tags = {
  project: "partner-integration-reliability-hub",
  environment: "demo",
  owner: "fisayo-rm",
  "managed-by": "cdk",
  "cost-center": "project-demo",
};

abstract class PirhStack extends Stack {
  public constructor(scope: App, id: string) {
    super(scope, id, {
      env,
      description: "Partner Integration Reliability Hub demo environment",
    });
    Object.entries(tags).forEach(([key, value]) =>
      Tags.of(this).add(key, value),
    );
  }
}

class IdentityStack extends PirhStack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public constructor(scope: App) {
    super(scope, "PirhDemoIdentity");
    this.userPool = new cognito.UserPool(this, "ConsoleUsers", {
      userPoolName: "pirh-demo-console-users",
      selfSignUpEnabled: false,
      removalPolicy: RemovalPolicy.RETAIN,
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
        userPoolId: this.userPool.userPoolId,
      });
    this.userPoolClient = this.userPool.addClient("ConsoleSpa", {
      userPoolClientName: "pirh-demo-console-spa",
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          "https://partner-integration-reliability-hub-demo.pages.dev/auth/callback",
          "http://localhost:5173/auth/callback",
        ],
        logoutUrls: [
          "https://partner-integration-reliability-hub-demo.pages.dev/",
          "http://localhost:5173/",
        ],
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });
    new CfnOutput(this, "CognitoIssuer", {
      value: this.userPool.userPoolProviderUrl,
    });
    new CfnOutput(this, "CognitoClientId", {
      value: this.userPoolClient.userPoolClientId,
    });
  }
}

class DataStack extends PirhStack {
  public readonly core: dynamodb.Table;
  public readonly audit: dynamodb.Table;
  public constructor(scope: App) {
    super(scope, "PirhDemoData");
    this.core = new dynamodb.Table(this, "Core", {
      tableName: "pirh-demo-core",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      timeToLiveAttribute: "expiresAt",
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.core.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      readCapacity: 5,
      writeCapacity: 5,
    });
    this.audit = new dynamodb.Table(this, "Audit", {
      tableName: "pirh-demo-audit",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
  }
}

class MessagingStack extends PirhStack {
  public readonly routing: sqs.Queue;
  public readonly delivery: sqs.Queue;
  public readonly streamFailures: sqs.Queue;
  public readonly schedulerRole: iam.Role;
  public constructor(scope: App) {
    super(scope, "PirhDemoMessaging");
    const queue = (id: string, retention: Duration) => {
      const dlq = new sqs.Queue(this, `${id}Dlq`, {
        queueName: `pirh-demo-${id.toLowerCase()}-dlq`,
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
      });
      return new sqs.Queue(this, id, {
        queueName: `pirh-demo-${id.toLowerCase()}`,
        retentionPeriod: retention,
        visibilityTimeout: Duration.seconds(360),
        enforceSSL: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      });
    };
    this.routing = queue("Routing", Duration.days(4));
    this.delivery = queue("Delivery", Duration.days(14));
    this.streamFailures = new sqs.Queue(this, "OutboxStreamFailures", {
      queueName: "pirh-demo-outbox-stream-failures",
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    this.schedulerRole = new iam.Role(this, "OneTimeSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    this.delivery.grantSendMessages(this.schedulerRole);
  }
}

interface FunctionSet {
  readonly api: lambda.Alias;
  readonly outbox: lambda.Alias;
  readonly router: lambda.Alias;
  readonly delivery: lambda.Alias;
  readonly reconciler: lambda.Alias;
}
function workerFunction(
  stack: Stack,
  id: string,
  entry: string,
  memorySize: number,
  timeout: Duration,
  concurrency: number,
  environment: Record<string, string>,
) {
  const accountReservation = Number.parseInt(
    process.env.PIRH_DEMO_RESERVED_CONCURRENCY ?? "0",
    10,
  );
  const fn = new NodejsFunction(stack, id, {
    entry: source(entry),
    handler:
      id === "Api"
        ? "httpApiHandler"
        : id === "Reconciler"
          ? "scheduledHandler"
          : id === "Outbox"
            ? "streamHandler"
            : "sqsHandler",
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize,
    timeout,
    ...(accountReservation > 0
      ? {
          reservedConcurrentExecutions: Math.min(
            concurrency,
            accountReservation,
          ),
        }
      : {}),
    tracing: lambda.Tracing.ACTIVE,
    logRetention: logs.RetentionDays.ONE_WEEK,
    environment: {
      APP_ENV: "demo",
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      ...environment,
    },
    bundling: { minify: true, sourceMap: true, target: "node24" },
  });
  const version = fn.currentVersion;
  const alias = new lambda.Alias(stack, `${id}Live`, {
    aliasName: "live",
    version,
  });
  return { fn, alias };
}

class ApiStack extends PirhStack {
  public readonly functions: Pick<FunctionSet, "api">;
  public readonly httpApi: apigwv2.HttpApi;
  public constructor(
    scope: App,
    identity: IdentityStack,
    data: DataStack,
    messaging: MessagingStack,
  ) {
    super(scope, "PirhDemoApi");
    const common = {
      CORE_TABLE_NAME: data.core.tableName,
      AUDIT_TABLE_NAME: data.audit.tableName,
      ROUTING_QUEUE_NAME: messaging.routing.queueName,
      DELIVERY_QUEUE_NAME: messaging.delivery.queueName,
      SSM_SECRET_PREFIX: "/pirh/demo/tenants",
      CURSOR_SECRET_PARAMETER: "/pirh/demo/system/cursor-secret",
      PORTABILITY_PLAN_SIGNING_KEY_PARAMETER:
        "/pirh/demo/system/portability-plan-signing-key",
      OIDC_ISSUER: identity.userPool.userPoolProviderUrl,
      OIDC_AUDIENCE: identity.userPoolClient.userPoolClientId,
      OIDC_JWKS_URI: `${identity.userPool.userPoolProviderUrl}/.well-known/jwks.json`,
      CONSOLE_ORIGIN:
        "https://partner-integration-reliability-hub-demo.pages.dev",
    };
    const api = workerFunction(
      this,
      "Api",
      "apps/api/src/handler.ts",
      512,
      Duration.seconds(15),
      10,
      common,
    );
    data.core.grantReadWriteData(api.fn);
    data.audit.grantReadWriteData(api.fn);
    messaging.routing.grantConsumeMessages(api.fn);
    messaging.delivery.grantConsumeMessages(api.fn);
    api.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${region}:${account ?? "*"}:parameter/pirh/demo/*`,
        ],
      }),
    );
    this.functions = { api: api.alias };
    const deploymentApplication = new codedeploy.LambdaApplication(
      this,
      "LambdaDeployments",
    );
    const preTraffic = new NodejsFunction(this, "ApiPreTrafficSmoke", {
      entry: source("infrastructure/cdk/src/pretraffic.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(15),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    preTraffic.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codedeploy:PutLifecycleEventHookExecutionStatus"],
        resources: ["*"],
      }),
    );
    new codedeploy.LambdaDeploymentGroup(this, "ApiLivePromotion", {
      application: deploymentApplication,
      alias: api.alias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE,
      preHook: preTraffic,
    });
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "pirh-demo",
      corsPreflight: {
        allowOrigins: [
          "https://partner-integration-reliability-hub-demo.pages.dev",
          "http://localhost:5173",
        ],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: [
          "authorization",
          "content-type",
          "idempotency-key",
          "x-client-id",
          "x-timestamp",
          "x-nonce",
          "x-signature",
        ],
        maxAge: Duration.hours(1),
      },
      createDefaultStage: true,
    });
    const integration = new integrations.HttpLambdaIntegration(
      "ApiLiveIntegration",
      api.alias,
    );
    const jwt = new authorizers.HttpJwtAuthorizer(
      "ConsoleJwt",
      identity.userPool.userPoolProviderUrl,
      { jwtAudience: [identity.userPoolClient.userPoolClientId] },
    );
    for (const path of [
      "/health/live",
      "/health/ready",
      "/api/v1/meta",
      "/openapi.json",
      "/api/v1/events",
      "/api/v1/events/{eventId}",
    ])
      this.httpApi.addRoutes({
        path,
        methods:
          path === "/api/v1/events"
            ? [apigwv2.HttpMethod.POST]
            : [apigwv2.HttpMethod.GET],
        integration,
      });
    for (const path of [
      "/api/v1/session",
      "/api/v1/deliveries",
      "/api/v1/audit-logs",
      "/api/v1/operational-rollups",
      "/api/v1/partners",
      "/api/v1/destinations",
      "/api/v1/subscriptions",
      "/api/v1/transformations",
      "/api/v1/configuration-plans",
    ])
      this.httpApi.addRoutes({
        path,
        methods: [apigwv2.HttpMethod.ANY],
        integration,
        authorizer: jwt,
      });
    new CfnOutput(this, "ApiUrl", { value: this.httpApi.apiEndpoint });
  }
}

class WorkerStack extends PirhStack {
  public readonly functions: Omit<FunctionSet, "api">;
  public constructor(scope: App, data: DataStack, messaging: MessagingStack) {
    super(scope, "PirhDemoWorkers");
    const common = {
      CORE_TABLE_NAME: data.core.tableName,
      AUDIT_TABLE_NAME: data.audit.tableName,
      ROUTING_QUEUE_NAME: messaging.routing.queueName,
      DELIVERY_QUEUE_NAME: messaging.delivery.queueName,
      SSM_SECRET_PREFIX: "/pirh/demo/tenants",
      DELIVERY_QUEUE_ARN: messaging.delivery.queueArn,
      SCHEDULER_EXECUTION_ROLE_ARN: messaging.schedulerRole.roleArn,
    };
    const outbox = workerFunction(
      this,
      "Outbox",
      "apps/outbox-worker/src/lambda.ts",
      256,
      Duration.seconds(30),
      10,
      common,
    );
    const router = workerFunction(
      this,
      "Router",
      "apps/router-worker/src/lambda.ts",
      512,
      Duration.seconds(60),
      10,
      common,
    );
    const delivery = workerFunction(
      this,
      "Delivery",
      "apps/delivery-worker/src/lambda.ts",
      512,
      Duration.seconds(60),
      20,
      common,
    );
    const reconciler = workerFunction(
      this,
      "Reconciler",
      "apps/outbox-reconciler/src/lambda.ts",
      256,
      Duration.seconds(60),
      1,
      common,
    );
    for (const value of [outbox.fn, router.fn, delivery.fn, reconciler.fn]) {
      data.core.grantReadWriteData(value);
      data.audit.grantReadWriteData(value);
    }
    messaging.routing.grantConsumeMessages(router.fn);
    messaging.delivery.grantConsumeMessages(delivery.fn);
    messaging.delivery.grantSendMessages(outbox.fn);
    messaging.delivery.grantSendMessages(reconciler.fn);
    messaging.routing.grantSendMessages(outbox.fn);
    messaging.routing.grantSendMessages(reconciler.fn);
    for (const value of [outbox.fn, reconciler.fn])
      value.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["scheduler:CreateSchedule"],
          resources: ["*"],
        }),
      );
    delivery.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${region}:${account ?? "*"}:parameter/pirh/demo/*`,
        ],
      }),
    );
    outbox.fn.addEventSource(
      new lambdaEvents.DynamoEventSource(data.core, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new lambdaEvents.SqsDlq(messaging.streamFailures),
      }),
    );
    router.fn.addEventSource(
      new lambdaEvents.SqsEventSource(messaging.routing, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxConcurrency: 10,
      }),
    );
    delivery.fn.addEventSource(
      new lambdaEvents.SqsEventSource(messaging.delivery, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxConcurrency: 20,
      }),
    );
    new events.Rule(this, "OutboxReconcileEveryMinute", {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(reconciler.alias)],
    });
    this.functions = {
      outbox: outbox.alias,
      router: router.alias,
      delivery: delivery.alias,
      reconciler: reconciler.alias,
    };
  }
}

class MockPartnerStack extends PirhStack {
  public constructor(scope: App, data: DataStack) {
    super(scope, "PirhDemoMockPartners");
    for (const [id, entry] of [
      ["MockAlpha", "apps/mock-partner-alpha/src/lambda.ts"],
      ["MockBeta", "apps/mock-partner-beta/src/lambda.ts"],
    ] as const) {
      const value = workerFunction(
        this,
        id,
        entry,
        256,
        Duration.seconds(15),
        5,
        {
          MOCK_CONTROL_TOKEN_PARAMETER: "/pirh/demo/system/mock-control-token",
          ...(id === "MockAlpha"
            ? { MOCK_ALPHA_API_KEY_PARAMETER: "/pirh/demo/mock/alpha/api-key" }
            : {
                MOCK_BETA_CLIENT_ID_PARAMETER: "/pirh/demo/mock/beta/client-id",
                MOCK_BETA_CLIENT_SECRET_PARAMETER:
                  "/pirh/demo/mock/beta/client-secret",
              }),
        },
      );
      data.core.grantReadWriteData(value.fn);
      value.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            `arn:aws:ssm:${region}:${account ?? "*"}:parameter/pirh/demo/*`,
          ],
        }),
      );
      const url = value.alias.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE,
        invokeMode: lambda.InvokeMode.BUFFERED,
      });
      new CfnOutput(this, `${id}Url`, { value: url.url });
    }
  }
}

class ObservabilityStack extends PirhStack {
  public constructor(
    scope: App,
    api: ApiStack,
    workers: WorkerStack,
    messaging: MessagingStack,
  ) {
    super(scope, "PirhDemoObservability");
    const values = [
      api.functions.api,
      workers.functions.outbox,
      workers.functions.router,
      workers.functions.delivery,
      workers.functions.reconciler,
    ];
    const dashboard = new cloudwatch.Dashboard(this, "ReliabilityHub", {
      dashboardName: "pirh-demo-reliability-hub",
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Lambda errors",
        left: values.map((value) =>
          value.metricErrors({ period: Duration.minutes(5) }),
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "Queue age",
        left: [
          messaging.routing.metricApproximateAgeOfOldestMessage(),
          messaging.delivery.metricApproximateAgeOfOldestMessage(),
        ],
      }),
    );
    for (const queue of [messaging.routing, messaging.delivery])
      queue.deadLetterQueue?.queue
        .metricApproximateNumberOfMessagesVisible()
        .createAlarm(this, `${queue.node.id}DlqAlarm`, {
          threshold: 0,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        });
    for (const value of values)
      value
        .metricErrors({ period: Duration.minutes(5) })
        .createAlarm(this, `${value.node.id}Errors`, {
          threshold: 1,
          evaluationPeriods: 1,
        });
  }
}

const identity = new IdentityStack(app);
const data = new DataStack(app);
const messaging = new MessagingStack(app);
const api = new ApiStack(app, identity, data, messaging);
const workers = new WorkerStack(app, data, messaging);
new MockPartnerStack(app, data);
new ObservabilityStack(app, api, workers, messaging);
new AwsSolutionsChecks(app);
app.synth();
