import { expect, test } from "vitest";
import {
  SafePartnerHttpClient,
  UnsafeDestinationError,
  captureResponse,
} from "../../packages/partner-http/src/index.js";

test("safe partner HTTP validation rejects private, metadata, and rebinding answers", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
  ]) {
    const client = new SafePartnerHttpClient({
      mode: "hosted",
      resolve: async () => [address],
    });
    await expect(
      client.validateUrl("https://partner.example/path"),
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
  }
  const local = new SafePartnerHttpClient({
    mode: "local",
    localHttpHostnames: ["mock-partner-alpha"],
    resolve: async () => ["172.20.0.2"],
  });
  await expect(
    local.validateUrl("http://mock-partner-alpha/path"),
  ).resolves.toBeInstanceOf(URL);
});
test("response capture uses an allowlist, body redaction, and a bounded excerpt", () => {
  const result = captureResponse({
    headers: { "set-cookie": "secret", "retry-after": "3" },
    body: JSON.stringify({ token: "secret", keep: "ok" }),
    redactionPaths: ["$.token"],
  });
  expect(result.headers).toEqual({ "retry-after": "3" });
  expect(result.bodyExcerpt).toContain("[REDACTED]");
  expect(result.bodyExcerpt).not.toContain("secret");
});
