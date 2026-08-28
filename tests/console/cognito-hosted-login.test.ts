import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("console uses Cognito's issuer for validation and hosted domain for OAuth", async () => {
  const source = await readFile(
    new URL("../../apps/console/src/app.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toContain("VITE_OIDC_HOSTED_LOGIN_AUTHORITY");
  expect(source).toContain("config.hostedLoginAuthority === undefined");
  expect(source).toContain("authorization_endpoint");
  expect(source).toContain("/oauth2/authorize");
  expect(source).toContain("jwks_uri");
  expect(source).toContain('url.searchParams.set("logout_uri"');
  expect(source).toContain("await manager.removeUser()");
});

test("Cognito allows the console logout destination", async () => {
  const source = await readFile(
    new URL("../../infrastructure/cdk/src/app.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain(
    '"https://partner-integration-reliability-hub-demo.pages.dev/login"',
  );
});

test("hosted smoke signs in through Cognito instead of forging browser storage", async () => {
  const source = await readFile(
    new URL("../../scripts/smoke-hosted.mjs", import.meta.url),
    "utf8",
  );
  expect(source).toContain('input[name="username"]');
  expect(source).toContain('input[name="password"]');
  expect(source).toContain("form#primary-form button[type=submit]");
  expect(source).not.toContain("addInitScript");
});

test("hosted smoke requires protected runner injection and does not read plaintext parameters", async () => {
  const source = await readFile(
    new URL("../../scripts/smoke-hosted.mjs", import.meta.url),
    "utf8",
  );
  expect(source).toContain("HOSTED_PRODUCER_SECRET");
  expect(source).toContain("HOSTED_MOCK_CONTROL_TOKEN");
  expect(source).not.toContain("@aws-sdk/client-ssm");
  expect(source).not.toContain("GetParameterCommand");
  expect(source).not.toContain("WithDecryption");
});
