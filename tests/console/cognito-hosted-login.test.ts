import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("console uses Cognito's issuer for validation and hosted domain for OAuth", async () => {
  const source = await readFile(
    new URL("../../apps/console/src/app.tsx", import.meta.url),
    "utf8",
  );
  expect(source).toContain("VITE_OIDC_HOSTED_LOGIN_AUTHORITY");
  expect(source).toContain("authorization_endpoint");
  expect(source).toContain("/oauth2/authorize");
  expect(source).toContain("jwks_uri");
});
