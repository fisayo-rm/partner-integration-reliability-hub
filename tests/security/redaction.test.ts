import { expect, test } from "vitest";
import {
  bounded,
  redactError,
  redactHeaders,
  redactJson,
  redactUnknown,
} from "../../packages/redaction/src/index.js";

const secret = "super-secret-m07-fixture";

test("recursive redaction removes credentials from fields, headers, payloads, and errors", () => {
  const value = redactUnknown({
    authorization: `Bearer ${secret}`,
    nested: { clientSecret: secret, oauth: { token: secret } },
    headers: { cookie: secret, "x-request-id": "safe" },
    payload: { secret },
  });
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(secret);
  expect(serialized).toContain("[REDACTED]");
  expect(
    redactHeaders({ "x-api-key": secret, "x-request-id": "safe" }),
  ).toEqual({
    "x-api-key": "[REDACTED]",
    "x-request-id": "safe",
  });
  expect(
    JSON.stringify(
      redactJson({ payment: { token: secret } }, ["$.payment.token"]),
    ),
  ).not.toContain(secret);
  expect(
    JSON.stringify(redactError(new Error(`token=${secret}`))),
  ).not.toContain(secret);
  expect(bounded("x".repeat(3_000))).toHaveLength(2_049);
});
