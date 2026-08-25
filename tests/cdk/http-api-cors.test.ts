import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("protected HTTP routes leave OPTIONS to the API CORS preflight handler", async () => {
  const source = await readFile(
    new URL("../../infrastructure/cdk/src/app.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("const protectedHttpRoutes");
  expect(source).not.toContain("methods: [apigwv2.HttpMethod.ANY]");
});

test("the hosted API includes console list and detail routes", async () => {
  const source = await readFile(
    new URL("../../infrastructure/cdk/src/app.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain('path: "/api/v1/events"');
  expect(source).toContain('path: "/api/v1/deliveries/{deliveryId}"');
  expect(source).toContain('path: "/api/v1/deliveries/{deliveryId}/replays"');
});

test("the API alias uses one API-scoped invoke permission", async () => {
  const source = await readFile(
    new URL("../../infrastructure/cdk/src/app.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain("scopePermissionToRoute: false");
});
