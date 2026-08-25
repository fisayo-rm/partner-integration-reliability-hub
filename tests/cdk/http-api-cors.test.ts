import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("protected HTTP routes leave OPTIONS to the API CORS preflight handler", async () => {
  const source = await readFile(
    new URL("../../infrastructure/cdk/src/app.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("const protectedHttpMethods");
  expect(source).toContain("methods: protectedHttpMethods");
  expect(source).not.toContain("methods: [apigwv2.HttpMethod.ANY]");
});
