import { randomBytes } from "node:crypto";
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const region = process.env.AWS_REGION ?? "us-east-1";
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const coreTable = process.env.CORE_TABLE_NAME;
if (userPoolId === undefined || coreTable === undefined)
  throw new Error("COGNITO_USER_POOL_ID and CORE_TABLE_NAME are required.");
const requiredPassword = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 14)
    throw new Error(
      `${name} must be supplied through the protected demo environment.`,
    );
  return value;
};
const cognito = new CognitoIdentityProviderClient({ region });
const ssm = new SSMClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const tenantId = "tenant_01J0A1B2C3D4E5F6G7H8J9K0MN";

async function parameter(name, value) {
  await ssm
    .send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: "SecureString",
        Overwrite: false,
      }),
    )
    .catch((error) => {
      if (error.name !== "ParameterAlreadyExists") throw error;
    });
}
async function user(email, group, password) {
  let subject;
  try {
    const existing = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }),
    );
    subject = existing.UserAttributes?.find(
      (attribute) => attribute.Name === "sub",
    )?.Value;
  } catch (error) {
    if (error.name !== "UserNotFoundException") throw error;
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        TemporaryPassword: password,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      }),
    );
    subject = created.User?.Attributes?.find(
      (attribute) => attribute.Name === "sub",
    )?.Value;
  }
  if (subject === undefined) throw new Error("Cognito subject unavailable.");
  await cognito.send(
    new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: email,
      GroupName: group,
    }),
  );
  await ddb
    .send(
      new PutCommand({
        TableName: coreTable,
        Item: {
          PK: `IDENTITY#${process.env.OIDC_ISSUER ?? "cognito"}`,
          SK: `SUB#${subject}`,
          entityType: "IDENTITY",
          issuer: process.env.OIDC_ISSUER ?? "cognito",
          subject,
          tenantId,
          userId: email,
          role: group,
          status: "active",
          createdAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    )
    .catch((error) => {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    });
}

await Promise.all([
  parameter(
    "/pirh/demo/system/cursor-secret",
    randomBytes(32).toString("base64url"),
  ),
  parameter(
    "/pirh/demo/system/portability-plan-signing-key",
    randomBytes(32).toString("base64"),
  ),
  parameter(
    "/pirh/demo/system/mock-control-token",
    randomBytes(24).toString("base64url"),
  ),
  parameter(
    `/pirh/demo/tenants/${tenantId}/secrets/producer-current`,
    randomBytes(32).toString("base64url"),
  ),
  parameter(
    "/pirh/demo/mock/alpha/api-key",
    randomBytes(24).toString("base64url"),
  ),
  parameter("/pirh/demo/mock/beta/client-id", "pirh-demo-beta"),
  parameter(
    "/pirh/demo/mock/beta/client-secret",
    randomBytes(24).toString("base64url"),
  ),
]);
await user("admin@pirh.demo", "admin", requiredPassword("DEMO_ADMIN_PASSWORD"));
await user(
  "operator@pirh.demo",
  "operator",
  requiredPassword("DEMO_OPERATOR_PASSWORD"),
);
await user(
  "viewer@pirh.demo",
  "viewer",
  requiredPassword("DEMO_VIEWER_PASSWORD"),
);
console.log(
  JSON.stringify({
    seeded: true,
    tenantId,
    users: 3,
    parameters: "created-or-preserved",
  }),
);
