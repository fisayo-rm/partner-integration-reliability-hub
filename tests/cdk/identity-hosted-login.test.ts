import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("demo identity stack provisions a managed Cognito hosted-login domain", async () => {
  const source = await readFile(
    new URL("../../infrastructure/cdk/src/app.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain('this.userPool.addDomain("HostedLoginDomain"');
  expect(source).toContain('domainPrefix: "pirh-demo-auth"');
  expect(source).toContain("hostedLoginDomain.baseUrl()");
  expect(source).toContain("CfnManagedLoginBranding");
  expect(source).toContain("useCognitoProvidedValues: true");
  expect(source).toContain("CognitoHostedLoginAuthority");
});
